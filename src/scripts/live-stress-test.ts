import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool, getPoolMetrics } from "../db/index.js";
import { liveBidService } from "../services/live-bid.service.js";

/**
 * Sustained open-loop stress driver for the live bid path.
 *
 * Unlike live-load-harness (which fires one closed-loop wave and waits), this
 * holds a fixed *arrival rate* for a fixed duration regardless of how fast the
 * server replies. That is the only way to see a capacity ceiling: when a closed
 * loop hits a slow server it quietly lowers its own offered rate, so the test
 * always "passes". Here the backlog grows instead, and latency shows it.
 *
 * Run (after seed:stress-auctions):
 *
 *   TARGET_RPS=500 DURATION_SEC=30 pnpm --filter @auctionit/api live:stress
 *
 * Config:
 *   MODE                "http" (full stack, default) | "direct" (in-process placeBid)
 *   BASE_URL            API origin for http mode       (default: http://localhost:3500)
 *   TARGET_RPS          bids offered per second        (default: 500)
 *   DURATION_SEC        how long to hold the rate      (default: 30)
 *   RAMP_SEC            linear ramp to TARGET_RPS      (default: 0)
 *   AUCTION_IDS         comma-separated; default: discovered STRESS-* fixture
 *   LOT_IDS             comma-separated; default: every lot of those auctions
 *   AUCTION_LIMIT       cap how many auctions to target (default: all)
 *   LOTS_PER_AUCTION    cap lots per auction — the concentration knob
 *   BIDDERS_PER_AUCTION cap the rotating bidder pool   (default: 100)
 *   MAX_INFLIGHT        shed rather than queue past this (default: 4000)
 *   MAX_SOCKETS         http keep-alive sockets         (default: 512)
 *   REQ_TIMEOUT_MS      per-request timeout             (default: 30000)
 *   DRAIN_SEC           how long to wait for stragglers (default: 30)
 *   JSON_OUT            path to write the full result as JSON
 *
 * http mode mints a session token for each bidder user (the same single-session
 * column `/auth/login` writes) and restores the previous values on exit, so a
 * run does not permanently log anyone out.
 */

export type StressMode = "http" | "direct";

export type StressConfig = {
  label: string;
  mode: StressMode;
  baseUrl: string;
  targetRps: number;
  durationSec: number;
  rampSec: number;
  auctionIds: number[];
  lotIds: number[];
  auctionLimit: number;
  lotsPerAuction: number;
  biddersPerAuction: number;
  maxInflight: number;
  maxSockets: number;
  reqTimeoutMs: number;
  drainSec: number;
  /** Suppress the per-second progress lines (used by the suite runner). */
  quiet: boolean;
};

export type StressResult = {
  config: StressConfig;
  targets: { auctions: number; lots: number; bidders: number };
  throughput: {
    offeredRps: number;
    completedRps: number;
    acceptedRps: number;
    emitted: number;
    completed: number;
    shed: number;
    peakInflight: number;
  };
  latency: { p50: number; p90: number; p95: number; p99: number; max: number };
  outcomes: { accepted: number; rejected: number; errored: number };
  reasons: Record<string, number>;
  pool: { peakTotal: number; peakWaiting: number };
  perSec: { sec: number; done: number; accepted: number; p99: number }[];
  lotState: {
    lotId: number;
    winningAmount: string | null;
    bidCount: number;
    bidderCount: number;
  }[];
};

const TEST_ID_BASE = 1_900_000_000;
const STRESS_PREFIX = "STRESS-";
/**
 * The server rejects anything more than 50 increments above the standing bid.
 * Stay below that so the allocator's optimistic lead never degenerates into
 * every bid being a cap rejection when a lot falls behind.
 */
const LEAD_CAP_STEPS = 40;

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const parseIds = (v: string | undefined): number[] =>
  (v ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx]!;
}

const fmt = (n: number, digits = 1) =>
  Number.isFinite(n) ? n.toFixed(digits) : "—";

export function configFromEnv(overrides: Partial<StressConfig> = {}): StressConfig {
  return {
    label: "stress",
    mode: process.env.MODE === "direct" ? "direct" : "http",
    baseUrl: process.env.BASE_URL ?? "http://localhost:3500",
    targetRps: num(process.env.TARGET_RPS, 500),
    durationSec: num(process.env.DURATION_SEC, 30),
    rampSec: num(process.env.RAMP_SEC, 0),
    auctionIds: parseIds(process.env.AUCTION_IDS),
    lotIds: parseIds(process.env.LOT_IDS),
    auctionLimit: num(process.env.AUCTION_LIMIT, Number.MAX_SAFE_INTEGER),
    lotsPerAuction: num(process.env.LOTS_PER_AUCTION, Number.MAX_SAFE_INTEGER),
    biddersPerAuction: num(process.env.BIDDERS_PER_AUCTION, 100),
    maxInflight: num(process.env.MAX_INFLIGHT, 4000),
    maxSockets: num(process.env.MAX_SOCKETS, 512),
    reqTimeoutMs: num(process.env.REQ_TIMEOUT_MS, 30_000),
    drainSec: num(process.env.DRAIN_SEC, 30),
    quiet: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

type LotTarget = {
  lotId: number;
  auctionId: number;
  startPrice: number;
  increment: number;
  /** Next step index to hand out; amount = startPrice + steps × increment. */
  allocatedSteps: number;
  /** Highest step index the server has confirmed as winning (−1 = no bids). */
  knownWinningSteps: number;
};

type Bidder = { bidderId: number; userId: number; token?: string };

async function loadLots(cfg: StressConfig): Promise<LotTarget[]> {
  const where =
    cfg.lotIds.length > 0
      ? sql`l.id IN (${sql.join(
          cfg.lotIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : cfg.auctionIds.length > 0
        ? sql`l.auction_id IN (${sql.join(
            cfg.auctionIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql`a.auction_number LIKE ${`${STRESS_PREFIX}%`} AND a.auction_id >= ${TEST_ID_BASE}`;

  const rows = (
    await db.execute<{
      lot_id: number;
      auction_id: number;
      start_bid_price: string | null;
      bid_increment: string | null;
      winning_amount: string | null;
      auction_type: string | null;
    }>(sql`
      SELECT l.id AS lot_id, l.auction_id, l.start_bid_price, l.bid_increment,
             l.winning_amount, a.auction_type
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      WHERE l.is_active = true AND ${where}
      ORDER BY l.auction_id, l.display_order, l.id
    `)
  ).rows;

  if (rows.length === 0) {
    throw new Error(
      "No target lots. Run seed:stress-auctions, or set AUCTION_IDS / LOT_IDS.",
    );
  }
  const reverse = rows.filter(
    (r) => (r.auction_type ?? "").toLowerCase() === "reverse",
  );
  if (reverse.length > 0) {
    throw new Error(
      `Driver generates ascending amounts; ${reverse.length} target lot(s) belong to reverse auctions.`,
    );
  }

  const perAuction = new Map<number, number>();
  const targets: LotTarget[] = [];
  for (const r of rows) {
    if (perAuction.size >= cfg.auctionLimit && !perAuction.has(r.auction_id)) {
      continue;
    }
    const seen = perAuction.get(r.auction_id) ?? 0;
    if (seen >= cfg.lotsPerAuction) continue;
    perAuction.set(r.auction_id, seen + 1);

    const startPrice = Number(r.start_bid_price ?? 0);
    const increment = Number(r.bid_increment ?? 0);
    if (!(increment > 0)) {
      throw new Error(`Lot ${r.lot_id} has no bid increment.`);
    }
    const winningSteps =
      r.winning_amount != null
        ? Math.round((Number(r.winning_amount) - startPrice) / increment)
        : -1;
    targets.push({
      lotId: r.lot_id,
      auctionId: r.auction_id,
      startPrice,
      increment,
      knownWinningSteps: winningSteps,
      allocatedSteps: winningSteps + 1,
    });
  }
  return targets;
}

async function loadBidders(
  auctionIds: number[],
  perAuction: number,
): Promise<Map<number, Bidder[]>> {
  const rows = (
    await db.execute<{ auction_id: number; bidder_id: number; user_id: number }>(sql`
      SELECT m.auction_id, m.bidder_id, u.id AS user_id
      FROM auction_lot_bidder_maps m
      JOIN users u ON u.bidder_id = m.bidder_id AND u.is_active = true
      JOIN roles r ON r.id = u.role_id AND r.code = 'bidder'
      WHERE m.auction_id IN (${sql.join(
        auctionIds.map((id) => sql`${id}`),
        sql`, `,
      )})
        AND m.is_active = true
        AND m.lot_id IS NULL
      ORDER BY m.auction_id, m.bidder_id
    `)
  ).rows;

  const byAuction = new Map<number, Bidder[]>();
  for (const r of rows) {
    const list = byAuction.get(r.auction_id) ?? [];
    if (list.length >= perAuction) continue;
    list.push({ bidderId: r.bidder_id, userId: r.user_id });
    byAuction.set(r.auction_id, list);
  }
  for (const id of auctionIds) {
    if ((byAuction.get(id)?.length ?? 0) === 0) {
      throw new Error(
        `Auction ${id} has no auction-wide bidder map with an active bidder login.`,
      );
    }
  }
  return byAuction;
}

// ---------------------------------------------------------------------------
// Sessions (http mode)
// ---------------------------------------------------------------------------

type SavedSession = {
  userId: number;
  sessionId: string | null;
  sessionExpiresAt: string | null;
};

/**
 * Sessions live in a single column on `users`, so minting one evicts whatever
 * was there. Every exit path — including a crash — has to put it back.
 */
let pendingRestore: SavedSession[] = [];

async function mintSessions(bidders: Bidder[]): Promise<void> {
  const userIds = [...new Set(bidders.map((b) => b.userId))];
  const idList = sql.join(
    userIds.map((id) => sql`${id}`),
    sql`, `,
  );

  pendingRestore = (
    await db.execute<SavedSession>(sql`
      SELECT id AS "userId", session_id AS "sessionId",
             session_expires_at::text AS "sessionExpiresAt"
      FROM users WHERE id IN (${idList})
    `)
  ).rows;

  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const tokens = new Map<number, string>();
  for (const id of userIds) {
    tokens.set(id, `stress_${randomBytes(24).toString("base64url")}`);
  }
  for (const b of bidders) b.token = tokens.get(b.userId);

  const values = userIds.map(
    (id) => sql`(${id}::int, ${tokens.get(id)!}::varchar, ${expiresAt}::timestamptz)`,
  );
  await db.execute(sql`
    UPDATE users SET session_id = v.token, session_expires_at = v.exp
    FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, token, exp)
    WHERE users.id = v.id
  `);
}

export async function restoreSessions(): Promise<void> {
  const saved = pendingRestore;
  pendingRestore = [];
  if (saved.length === 0) return;
  const values = saved.map(
    (s) =>
      sql`(${s.userId}::int, ${s.sessionId}::varchar, ${s.sessionExpiresAt}::timestamptz)`,
  );
  await db.execute(sql`
    UPDATE users SET session_id = v.token, session_expires_at = v.exp
    FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, token, exp)
    WHERE users.id = v.id
  `);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

type HttpReply = { status: number; body: unknown };

function makeHttpClient(cfg: StressConfig) {
  const url = new URL(cfg.baseUrl);
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  const agentOpts = {
    keepAlive: true,
    maxSockets: cfg.maxSockets,
    maxFreeSockets: cfg.maxSockets,
  };
  const agent = secure ? new https.Agent(agentOpts) : new http.Agent(agentOpts);

  const request = (
    method: "GET" | "POST",
    path: string,
    token: string | null,
    payload: unknown,
  ): Promise<HttpReply> =>
    new Promise((resolve, reject) => {
      const data = payload == null ? null : Buffer.from(JSON.stringify(payload));
      const headers: Record<string, string> = { accept: "application/json" };
      if (data) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(data.byteLength);
      }
      if (token) headers.authorization = `Bearer ${token}`;

      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (secure ? 443 : 80),
          path,
          method,
          headers,
          agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let body: unknown = raw;
            try {
              body = raw ? JSON.parse(raw) : null;
            } catch {
              /* keep raw text */
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.setTimeout(cfg.reqTimeoutMs, () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });

  return { request, destroy: () => agent.destroy() };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type Sample = {
  sec: number;
  ms: number;
  outcome: "accepted" | "rejected" | "error";
};

export async function runStress(cfg: StressConfig): Promise<StressResult> {
  const lots = await loadLots(cfg);
  const auctionIds = [...new Set(lots.map((l) => l.auctionId))];
  const biddersByAuction = await loadBidders(auctionIds, cfg.biddersPerAuction);
  const allBidders = [...biddersByAuction.values()].flat();

  const client = cfg.mode === "http" ? makeHttpClient(cfg) : null;

  if (!cfg.quiet) {
    printHeader(cfg, {
      auctions: auctionIds.length,
      lots: lots.length,
      bidders: allBidders.length,
    });
  }

  try {
    if (client) {
      await mintSessions(allBidders);
      // Fail fast on a misconfigured origin rather than logging 15k auth errors.
      const probe = await client.request("GET", "/health", null, null).catch(
        (e: Error) => {
          throw new Error(`Cannot reach ${cfg.baseUrl}/health — ${e.message}`);
        },
      );
      if (probe.status !== 200) {
        throw new Error(`${cfg.baseUrl}/health returned ${probe.status}`);
      }
    }

    const samples: Sample[] = [];
    const secDone: number[] = [];
    const secAccepted: number[] = [];
    const secLatencies: number[][] = [];
    const reasons = new Map<string, number>();
    let emitted = 0;
    let shed = 0;
    let inflight = 0;
    let peakInflight = 0;
    let poolPeakWaiting = 0;
    let poolPeakTotal = 0;

    const bump = (reason: string) =>
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

    const record = (sec: number, ms: number, outcome: Sample["outcome"]) => {
      samples.push({ sec, ms, outcome });
      secDone[sec] = (secDone[sec] ?? 0) + 1;
      if (outcome === "accepted") {
        secAccepted[sec] = (secAccepted[sec] ?? 0) + 1;
      }
      (secLatencies[sec] ??= []).push(ms);
    };

    let lotCursor = 0;
    const bidderCursor = new Map<number, number>();
    const nextLot = (): LotTarget => lots[lotCursor++ % lots.length]!;
    const nextBidder = (auctionId: number): Bidder => {
      const list = biddersByAuction.get(auctionId)!;
      const i = bidderCursor.get(auctionId) ?? 0;
      bidderCursor.set(auctionId, i + 1);
      return list[i % list.length]!;
    };

    // Responses are the only truth about the standing bid. If we've raced far
    // ahead of the last confirmation, fall back to "one increment above known
    // winning" — those collide and get outbid-rejected, which is exactly what
    // real bidders experience on a contended lot.
    const allocate = (lot: LotTarget): number => {
      if (lot.allocatedSteps > lot.knownWinningSteps + LEAD_CAP_STEPS) {
        lot.allocatedSteps = lot.knownWinningSteps + 1;
      }
      return lot.startPrice + lot.allocatedSteps++ * lot.increment;
    };
    const confirm = (lot: LotTarget, finalAmount: number): void => {
      const steps = Math.round((finalAmount - lot.startPrice) / lot.increment);
      if (steps > lot.knownWinningSteps) lot.knownWinningSteps = steps;
      if (lot.allocatedSteps <= steps) lot.allocatedSteps = steps + 1;
    };

    const poolTimer = setInterval(() => {
      if (cfg.mode === "direct") {
        const m = getPoolMetrics();
        poolPeakWaiting = Math.max(poolPeakWaiting, m.waitingCount);
        poolPeakTotal = Math.max(poolPeakTotal, m.totalCount);
        return;
      }
      void client!
        .request("GET", "/health", null, null)
        .then((r) => {
          const p = (
            r.body as { pool?: { waitingCount: number; totalCount: number } }
          )?.pool;
          if (!p) return;
          poolPeakWaiting = Math.max(poolPeakWaiting, p.waitingCount);
          poolPeakTotal = Math.max(poolPeakTotal, p.totalCount);
        })
        .catch(() => {
          /* health probes must never fail the run */
        });
    }, 500);
    poolTimer.unref();

    const startedAt = performance.now();

    const fire = async (): Promise<void> => {
      inflight++;
      if (inflight > peakInflight) peakInflight = inflight;
      const lot = nextLot();
      const bidder = nextBidder(lot.auctionId);
      const amount = allocate(lot);
      const sec = Math.floor((performance.now() - startedAt) / 1000);
      const t0 = performance.now();
      try {
        if (cfg.mode === "direct") {
          const r = await liveBidService.placeBid({
            auctionId: lot.auctionId,
            lotId: lot.lotId,
            bidderId: bidder.bidderId,
            userId: bidder.userId,
            amount,
            ip: "stress",
          });
          const ms = performance.now() - t0;
          if (r.accepted) {
            // null only for rank-based auctions (winning amount withheld);
            // this tool doesn't target those, but falls back to the bidder's
            // own submitted amount for bookkeeping rather than crashing.
            confirm(lot, r.finalAmount ?? amount);
            record(sec, ms, "accepted");
          } else {
            bump(r.reason);
            record(sec, ms, "rejected");
          }
        } else {
          const r = await client!.request(
            "POST",
            `/live/auctions/${lot.auctionId}/lots/${lot.lotId}/bid`,
            bidder.token!,
            { amount },
          );
          const ms = performance.now() - t0;
          const body = r.body as
            | { ok?: true; finalAmount?: number; error?: string }
            | null;
          if (r.status === 200) {
            if (typeof body?.finalAmount === "number") {
              confirm(lot, body.finalAmount);
            }
            record(sec, ms, "accepted");
          } else if (r.status === 400) {
            bump(body?.error ?? "unknown");
            record(sec, ms, "rejected");
          } else {
            bump(`HTTP ${r.status}${body?.error ? `: ${body.error}` : ""}`);
            record(sec, ms, "error");
          }
        }
      } catch (e) {
        bump(e instanceof Error ? e.message : String(e));
        record(sec, performance.now() - t0, "error");
      } finally {
        inflight--;
      }
    };

    // Integral of the (optionally ramped) rate, so a tick that runs late catches
    // up instead of silently lowering the offered rate.
    const dueBy = (elapsedSec: number): number => {
      if (cfg.rampSec <= 0) return Math.floor(cfg.targetRps * elapsedSec);
      if (elapsedSec >= cfg.rampSec) {
        return Math.floor(
          (cfg.targetRps * cfg.rampSec) / 2 +
            cfg.targetRps * (elapsedSec - cfg.rampSec),
        );
      }
      return Math.floor(
        (cfg.targetRps * elapsedSec * elapsedSec) / (2 * cfg.rampSec),
      );
    };

    let lastReportSec = -1;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const elapsed = (performance.now() - startedAt) / 1000;
        const whole = Math.floor(elapsed);
        if (!cfg.quiet && whole > lastReportSec) {
          lastReportSec = whole;
          const s = whole - 1;
          if (s >= 0) {
            const lat = [...(secLatencies[s] ?? [])].sort((a, b) => a - b);
            console.log(
              `  t+${String(s).padStart(3)}s  done ${String(secDone[s] ?? 0).padStart(4)}/s` +
                `  accepted ${String(secAccepted[s] ?? 0).padStart(4)}/s` +
                `  p50 ${fmt(percentile(lat, 50)).padStart(8)} ms` +
                `  p99 ${fmt(percentile(lat, 99)).padStart(9)} ms` +
                `  inflight ${String(inflight).padStart(4)}`,
            );
          }
        }
        if (elapsed >= cfg.durationSec) {
          resolve();
          return;
        }
        const want = dueBy(elapsed) - emitted;
        for (let i = 0; i < want; i++) {
          emitted++;
          if (inflight >= cfg.maxInflight) {
            shed++;
            continue;
          }
          void fire();
        }
        setTimeout(tick, 10);
      };
      tick();
    });

    const offeredMs = performance.now() - startedAt;

    if (inflight > 0) {
      if (!cfg.quiet) console.log(`\n  Draining ${inflight} in-flight bid(s)…`);
      const deadline = Date.now() + cfg.drainSec * 1000;
      while (inflight > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (inflight > 0 && !cfg.quiet) {
        console.log(
          `  ⚠ ${inflight} request(s) still in flight after ${cfg.drainSec}s.`,
        );
      }
    }
    clearInterval(poolTimer);
    const totalMs = performance.now() - startedAt;

    const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
    const accepted = samples.filter((s) => s.outcome === "accepted").length;
    const rejected = samples.filter((s) => s.outcome === "rejected").length;
    const errored = samples.filter((s) => s.outcome === "error").length;

    const lotState = (
      await db.execute<{
        lot_id: number;
        winning_amount: string | null;
        bid_count: number;
        bidder_count: number;
      }>(sql`
        SELECT id AS lot_id, winning_amount, bid_count, bidder_count
        FROM auction_lots
        WHERE id IN (${sql.join(
          lots.map((l) => sql`${l.lotId}`),
          sql`, `,
        )})
        ORDER BY id
      `)
    ).rows;

    return {
      config: cfg,
      targets: {
        auctions: auctionIds.length,
        lots: lots.length,
        bidders: allBidders.length,
      },
      throughput: {
        offeredRps: emitted / (offeredMs / 1000),
        completedRps: samples.length / (totalMs / 1000),
        acceptedRps: accepted / (totalMs / 1000),
        emitted,
        completed: samples.length,
        shed,
        peakInflight,
      },
      latency: {
        p50: percentile(latencies, 50),
        p90: percentile(latencies, 90),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies[latencies.length - 1] ?? NaN,
      },
      outcomes: { accepted, rejected, errored },
      reasons: Object.fromEntries(reasons),
      pool: { peakTotal: poolPeakTotal, peakWaiting: poolPeakWaiting },
      perSec: Array.from({ length: cfg.durationSec }, (_, s) => ({
        sec: s,
        done: secDone[s] ?? 0,
        accepted: secAccepted[s] ?? 0,
        p99: percentile([...(secLatencies[s] ?? [])].sort((a, b) => a - b), 99),
      })),
      lotState: lotState.map((r) => ({
        lotId: r.lot_id,
        winningAmount: r.winning_amount,
        bidCount: Number(r.bid_count ?? 0),
        bidderCount: Number(r.bidder_count ?? 0),
      })),
    };
  } finally {
    await restoreSessions();
    client?.destroy();
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function printHeader(cfg: StressConfig, targets: StressResult["targets"]) {
  console.log(
    `  Mode         ${cfg.mode}${cfg.mode === "http" ? `  → ${cfg.baseUrl}` : ""}`,
  );
  console.log(
    `  Load         ${cfg.targetRps} bids/sec for ${cfg.durationSec}s` +
      (cfg.rampSec > 0 ? `  (ramp ${cfg.rampSec}s)` : ""),
  );
  console.log(
    `  Targets      ${targets.auctions} auction(s), ${targets.lots} lot(s)` +
      `  →  ${fmt(cfg.targetRps / targets.lots)} bids/sec per lot`,
  );
  console.log(`  Bidder pool  ${targets.bidders}`);
  console.log("");
}

/**
 * Completing every request is not the same as coping. Once the pool saturates,
 * requests still finish — they just queue first, which shows up as a p50 in the
 * hundreds of milliseconds rather than as an error. So grade on the median too,
 * not only on whether the offered rate came back.
 *
 * These are also the CI gate: a breach fails the command.
 */
export type StressThresholds = {
  maxP50Ms: number;
  maxP99Ms: number;
  /** Completed throughput must reach this share of the offered rate. */
  minCompletedPct: number;
  maxErrors: number;
};

export function thresholdsFromEnv(): StressThresholds {
  return {
    maxP50Ms: num(process.env.MAX_P50_MS, 50),
    maxP99Ms: num(process.env.MAX_P99_MS, 500),
    minCompletedPct: num(process.env.MIN_COMPLETED_PCT, 95),
    maxErrors: Number(process.env.MAX_ERRORS ?? 0),
  };
}

export type ThresholdCheck = {
  name: string;
  actual: string;
  limit: string;
  passed: boolean;
};

export function evaluateThresholds(
  r: StressResult,
  t: StressThresholds,
): ThresholdCheck[] {
  const completedPct = (r.throughput.completedRps / r.config.targetRps) * 100;
  return [
    {
      name: "completed throughput",
      actual: `${fmt(completedPct)}% of ${r.config.targetRps}/sec`,
      limit: `>= ${t.minCompletedPct}%`,
      passed: completedPct >= t.minCompletedPct,
    },
    {
      name: "p50 latency",
      actual: `${fmt(r.latency.p50)} ms`,
      limit: `<= ${t.maxP50Ms} ms`,
      passed: r.latency.p50 <= t.maxP50Ms,
    },
    {
      name: "p99 latency",
      actual: `${fmt(r.latency.p99)} ms`,
      limit: `<= ${t.maxP99Ms} ms`,
      passed: r.latency.p99 <= t.maxP99Ms,
    },
    {
      name: "errors",
      actual: String(r.outcomes.errored),
      limit: `<= ${t.maxErrors}`,
      passed: r.outcomes.errored <= t.maxErrors,
    },
    {
      name: "requests shed",
      actual: String(r.throughput.shed),
      limit: "0",
      passed: r.throughput.shed === 0,
    },
  ];
}

export function printThresholds(checks: ThresholdCheck[]): boolean {
  const allPassed = checks.every((c) => c.passed);
  console.log("\n  ── Thresholds ──────────────────────────────────────────");
  for (const c of checks) {
    console.log(
      `    ${c.passed ? "✔" : "✖"} ${c.name.padEnd(22)}` +
        `${c.actual.padStart(24)}   (limit ${c.limit})`,
    );
  }
  return allPassed;
}

export function verdictOf(r: StressResult): string {
  const t = thresholdsFromEnv();
  if (
    r.throughput.completedRps < r.config.targetRps * (t.minCompletedPct / 100) ||
    r.throughput.shed > 0 ||
    r.outcomes.errored > t.maxErrors
  ) {
    return (
      `✖ Did not sustain ${r.config.targetRps}/sec — completed ${fmt(r.throughput.completedRps)}/sec` +
      (r.throughput.shed > 0 ? `, shed ${r.throughput.shed}` : "") +
      (r.outcomes.errored > 0 ? `, ${r.outcomes.errored} error(s)` : "")
    );
  }
  if (r.latency.p50 > t.maxP50Ms) {
    return (
      `⚠ Kept up only by queueing — p50 ${fmt(r.latency.p50)} ms, p99 ${fmt(r.latency.p99)} ms` +
      `, peak ${r.pool.peakWaiting} waiting on a DB connection`
    );
  }
  if (r.latency.p99 > t.maxP99Ms) {
    return `⚠ Held the rate but p99 is ${fmt(r.latency.p99)} ms — bidders would feel the tail`;
  }
  return (
    `✔ Sustained ${r.config.targetRps}/sec — p50 ${fmt(r.latency.p50)} ms, p99 ${fmt(r.latency.p99)} ms`
  );
}

export function printReport(r: StressResult): void {
  console.log("\n  ── Throughput ──────────────────────────────────────────");
  console.log(
    `    Offered           ${fmt(r.throughput.offeredRps)} bids/sec  (${r.throughput.emitted} total)`,
  );
  console.log(
    `    Completed         ${fmt(r.throughput.completedRps)} bids/sec  (${r.throughput.completed} total)`,
  );
  console.log(
    `    Accepted          ${fmt(r.throughput.acceptedRps)} bids/sec  (${r.outcomes.accepted} total)`,
  );
  console.log(
    `    Shed (not sent)   ${r.throughput.shed}  ·  peak in-flight ${r.throughput.peakInflight}/${r.config.maxInflight}`,
  );

  console.log("\n  ── Latency (per bid request) ───────────────────────────");
  console.log(
    `    p50 ${fmt(r.latency.p50)} ms   p90 ${fmt(r.latency.p90)} ms   ` +
      `p95 ${fmt(r.latency.p95)} ms   p99 ${fmt(r.latency.p99)} ms   max ${fmt(r.latency.max)} ms`,
  );

  console.log("\n  ── Outcomes ────────────────────────────────────────────");
  const total = r.throughput.completed;
  const pct = (n: number) => (total > 0 ? `${fmt((n / total) * 100)}%` : "—");
  console.log(
    `    accepted  ${String(r.outcomes.accepted).padStart(6)}  ${pct(r.outcomes.accepted)}`,
  );
  console.log(
    `    rejected  ${String(r.outcomes.rejected).padStart(6)}  ${pct(r.outcomes.rejected)}`,
  );
  console.log(
    `    errors    ${String(r.outcomes.errored).padStart(6)}  ${pct(r.outcomes.errored)}`,
  );
  const reasons = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    console.log("\n    Top reasons:");
    for (const [reason, count] of reasons.slice(0, 8)) {
      console.log(`      ${String(count).padStart(6)}×  ${reason}`);
    }
  }

  console.log("\n  ── Postgres pool (sampled every 500 ms) ────────────────");
  console.log(
    `    peak connections ${r.pool.peakTotal}  ·  peak waiting ${r.pool.peakWaiting}`,
  );
  if (r.pool.peakWaiting > 0) {
    console.log("    ⚠ Requests queued for a DB connection — the pool is a ceiling.");
  }

  const ledger = r.lotState.reduce((a, l) => a + l.bidCount, 0);
  console.log("\n  ── Lot state after the run ─────────────────────────────");
  console.log(`    ledger bid_count across targets: ${ledger}`);
  for (const l of r.lotState.slice(0, 10)) {
    console.log(
      `      lot #${l.lotId}  winning ${l.winningAmount ?? "null"}  ` +
        `bids ${l.bidCount}  bidders ${l.bidderCount}`,
    );
  }
  if (r.lotState.length > 10) {
    console.log(`      …and ${r.lotState.length - 10} more`);
  }

  console.log("\n  ── Verdict ─────────────────────────────────────────────");
  console.log(`    ${verdictOf(r)}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const cfg = configFromEnv();
  console.log("\n⚡ Live bid stress test\n");
  const result = await runStress(cfg);
  printReport(result);
  const passed = printThresholds(
    evaluateThresholds(result, thresholdsFromEnv()),
  );
  console.log("");

  if (process.env.JSON_OUT) {
    writeFileSync(process.env.JSON_OUT, JSON.stringify(result, null, 2));
    console.log(`  Wrote ${process.env.JSON_OUT}\n`);
  }

  await pool.end();
  process.exit(passed ? 0 : 1);
}

const invokedDirectly = process.argv[1]?.includes("live-stress-test");
if (invokedDirectly) {
  main().catch(async (e) => {
    console.error("\nStress test failed:", e);
    try {
      await restoreSessions();
    } catch (restoreErr) {
      console.error(
        "Could not restore bidder sessions — affected users must log in again:",
        restoreErr,
      );
    }
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}

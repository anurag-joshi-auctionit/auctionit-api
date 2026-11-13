import { sql } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { liveBidService } from "../services/live-bid.service.js";

/**
 * Concurrent placeBid load harness against a live lot.
 *
 * Fires N parallel placeBid calls (one amount per bidder) via liveBidService,
 * reports latency percentiles, and prints the final winning amount from the DB.
 *
 * Run (after seed:live-proxy-auction or seed:live-auction):
 *
 *   AUCTION_ID=… LOT_ID=… BIDDER_IDS=1,2,3 USER_IDS=10,11,12 \
 *     pnpm --filter @auctionit/api live:load-harness
 *
 * Optional:
 *   BASE_AMOUNT   first bid amount (default: lot start, or winning±increment)
 *   INCREMENT     step between synthetic amounts (default: lot bid_increment)
 *   DIRECTION     "reverse" to subtract steps (default: forward / ascending)
 *   ROUNDS        how many parallel waves (default: 1)
 *   WAVE_SIZE     bids per wave; capped by bidder count (default: all bidders)
 */

function parseIds(envName: string): number[] {
  const raw = process.env[envName];
  if (!raw?.trim()) {
    throw new Error(`${envName} is required (comma-separated positive ints).`);
  }
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) {
    throw new Error(`${envName} must contain at least one positive id.`);
  }
  return ids;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx]!;
}

async function main() {
  const auctionId = num(process.env.AUCTION_ID, 0);
  const lotId = num(process.env.LOT_ID, 0);
  if (!auctionId || !lotId) {
    throw new Error("AUCTION_ID and LOT_ID are required.");
  }

  const bidderIds = parseIds("BIDDER_IDS");
  const userIds = parseIds("USER_IDS");
  if (bidderIds.length !== userIds.length) {
    throw new Error(
      `BIDDER_IDS (${bidderIds.length}) and USER_IDS (${userIds.length}) must be the same length.`,
    );
  }

  const lot = (
    await db.execute<{
      start_bid_price: string | null;
      bid_increment: string | null;
      winning_amount: string | null;
      auction_type: string | null;
    }>(sql`
      SELECT l.start_bid_price, l.bid_increment, l.winning_amount, a.auction_type
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      WHERE l.id = ${lotId} LIMIT 1
    `)
  ).rows[0];
  if (!lot) throw new Error(`Lot ${lotId} not found.`);

  const startPrice = Number(lot.start_bid_price ?? 0);
  const lotIncrement = Number(lot.bid_increment ?? 0);
  const currentWinning =
    lot.winning_amount != null ? Number(lot.winning_amount) : null;
  const increment = num(process.env.INCREMENT, lotIncrement || 100);
  const reverse =
    (process.env.DIRECTION ?? lot.auction_type ?? "").toLowerCase() ===
    "reverse";
  const stepSign = reverse ? -1 : 1;
  const rounds = num(process.env.ROUNDS, 1);
  const waveSize = Math.min(
    num(process.env.WAVE_SIZE, bidderIds.length),
    bidderIds.length,
  );

  const defaultBase =
    currentWinning != null ? currentWinning + stepSign * increment : startPrice;
  const baseAmount = num(process.env.BASE_AMOUNT, defaultBase);

  console.log("\n⚡ Live bid load harness\n");
  console.log(`  Auction    #${auctionId}  (${reverse ? "reverse" : "forward"})`);
  console.log(`  Lot        #${lotId}`);
  console.log(
    `  Bidders    ${waveSize} per wave × ${rounds} round(s)  (${bidderIds.slice(0, waveSize).join(", ")})`,
  );
  console.log(
    `  Amounts    base ${baseAmount}  ·  step ${stepSign * increment}  (current winning: ${currentWinning ?? "none"})`,
  );
  console.log("");

  type Outcome = {
    bidderId: number;
    amount: number;
    ms: number;
    accepted: boolean;
    reason?: string;
  };

  const outcomes: Outcome[] = [];

  for (let round = 0; round < rounds; round++) {
    const requests = Array.from({ length: waveSize }, (_, i) => {
      const bidderId = bidderIds[i]!;
      const userId = userIds[i]!;
      // Distinct amounts so at most one can win; tests serialization + latency.
      const amount = baseAmount + (round * waveSize + i) * stepSign * increment;
      return { bidderId, userId, amount };
    });

    const started = performance.now();
    const results = await Promise.all(
      requests.map(async (req) => {
        const t0 = performance.now();
        const result = await liveBidService.placeBid({
          auctionId,
          lotId,
          bidderId: req.bidderId,
          userId: req.userId,
          amount: req.amount,
          ip: "load-harness",
        });
        const ms = performance.now() - t0;
        return {
          bidderId: req.bidderId,
          amount: req.amount,
          ms,
          accepted: result.accepted,
          reason: result.accepted ? undefined : result.reason,
        } satisfies Outcome;
      }),
    );
    const waveMs = performance.now() - started;
    outcomes.push(...results);

    const accepted = results.filter((r) => r.accepted).length;
    console.log(
      `  Round ${round + 1}: ${accepted}/${results.length} accepted in ${waveMs.toFixed(1)} ms wall`,
    );
    for (const r of results) {
      const status = r.accepted ? "OK " : "REJ";
      const detail = r.accepted ? "" : `  (${r.reason})`;
      console.log(
        `    ${status}  bidder #${r.bidderId}  @ ${r.amount}  ${r.ms.toFixed(1)} ms${detail}`,
      );
    }
  }

  const latencies = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const acceptedCount = outcomes.filter((o) => o.accepted).length;

  console.log("\n  Latency (per placeBid call):");
  console.log(`    n=${latencies.length}  accepted=${acceptedCount}`);
  console.log(
    `    p50=${percentile(latencies, 50).toFixed(1)} ms  ` +
      `p95=${percentile(latencies, 95).toFixed(1)} ms  ` +
      `p99=${percentile(latencies, 99).toFixed(1)} ms  ` +
      `max=${(latencies[latencies.length - 1] ?? 0).toFixed(1)} ms`,
  );

  const final = (
    await db.execute<{
      winning_amount: string | null;
      winner_bidder_id: number | null;
      bid_count: number;
    }>(sql`
      SELECT winning_amount, winner_bidder_id, bid_count
      FROM auction_lots WHERE id = ${lotId} LIMIT 1
    `)
  ).rows[0];

  console.log("\n  Final winning amount from DB:");
  console.log(
    `    amount=${final?.winning_amount ?? "null"}  ` +
      `winner_bidder_id=${final?.winner_bidder_id ?? "null"}  ` +
      `bid_count=${final?.bid_count ?? 0}`,
  );
  console.log("");

  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("Load harness failed:", e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

import { sql } from "drizzle-orm";
import { bidDirectionFor } from "@auctionit/lib/live-bid-bounds";
import { db } from "../db/index.js";
import { loadRankings, withBidderRanks } from "../lib/auctions/rank.js";
import { timedLive } from "../lib/live-timing.js";
import { participantStanding } from "../live/participant-standing.js";
import { nextAuctionSeq } from "../live/sequence.js";
import type { AuctionVisibility } from "../live/visibility.js";
import { NO_BID_EXTENSION_PENDING } from "./no-bid-extension.service.js";

export type LiveState = "live" | "upcoming" | "ended";

export type LiveLot = {
  id: number;
  lotNumber: string | null;
  /** Catalogue display order within the auction (null = last). */
  displayOrder: number | null;
  title: string | null; // derived material name (first item) for lot cards
  materialLocation: string | null; // where the material sits (shown on cards)
  quantity: number | null;
  uom: string | null;
  // Bidder audience, sealed-bid phase only (see sealedPhaseSql): null — the
  // start price and bid limit are enforced by the server alone there.
  startBidPrice: number | null;
  bidIncrement: number;
  // winning_amount ?? start_bid_price. Bidder audience, rank-based auctions
  // and the sealed-bid phase: null — the winning amount must never reach the
  // bidder, over any channel (snapshot, delta, standing ping, bid response).
  currentBid: number | null;
  winnerBidderId: number | null; // winning bidder
  winnerBidderName: string | null; // winning bidder company name
  startsAt: string | null; // IST wall-clock ISO
  endsAt: string | null; // effective end (includes any anti-sniping extension)
  startLeftSec: number; // seconds until the lot opens (<= 0 once started)
  timeLeftSec: number; // clamped to >= 0
  notStarted: boolean; // true before the lot's start time — not yet biddable
  closed: boolean;
  // Admin reopened this lot: runs on its own end time, outside lot staggering,
  // with no extensions.
  reopened: boolean;
  lastBidExtensionCount: number;
  bidCount: number; // total bids placed on the lot (live engine)
  bidderCount: number; // distinct bidders who have bid
  bidLimit: number | null;
  // Monotonic per-lot revision (auction_lots.live_rev). Lets a client tell a
  // payload read before state it already holds from one read after it — a
  // whole-auction snapshot can be slower to build than the delta of a bid that
  // landed while it was being read.
  rev: number;
  // Auction "First Bid = Start Bid Price + Increment": when true, the opening bid
  // must clear SBP + one increment; when false, the opening bid is the SBP.
  sbpPlusIncrement: boolean;
  // Bidder audience only: relative standing vs winning (never competitor identity).
  yourStatus?: "winning" | "outbid" | "none";
  // Bidder's personal snapshot, rank-based auctions only: their live position
  // on the lot (1 = current winner) and their own best bid. Null until they've
  // bid on the lot; omitted entirely from shared/admin/client payloads.
  yourRank?: number | null;
  yourBid?: number | null;
};

/** lotId → this bidder's rank and own best bid. */
type PersonalRank = Map<number, { rank: number; best: number }>;

export type LiveAuctionSnapshot = {
  auction: {
    id: number;
    auctionNumber: string | null;
    auctionType: string | null;
    clientName: string | null;
    status: string;
    liveState: LiveState;
    isRankBased: boolean;
  };
  lots: LiveLot[];
  /** Postgres `now()` at snapshot read (UTC ISO). Used for capped transit anchoring. */
  serverTime: string;
  seq: number;
};

// A lightweight per-lot update pushed after a bid/proxy, so watchers can patch
// just the changed lot (winning / winner / counts / timers) instead of receiving a
// recomputed whole-auction snapshot.
export type LiveLotDelta = {
  auctionId: number;
  lotId: number;
  currentBid: number | null;
  winnerBidderId: number | null;
  winnerBidderName: string | null;
  bidCount: number;
  bidderCount: number;
  seq: number;
  /** Rank-based auctions mask `currentBid` for the bidder/public projection. */
  isRankBased?: boolean;
  /**
   * Sealed-bid phase (see sealedPhaseSql): `currentBid` is masked for the
   * bidder/public projection, since with no bids it is the withheld start price.
   */
  sealedPhase?: boolean;
  /** Per-lot revision — see LiveLot.rev. */
  rev: number;
  timeLeftSec?: number;
  startLeftSec?: number;
  endsAt?: string | null;
  lastBidExtensionCount?: number;
  closed?: boolean;
  notStarted?: boolean;
  yourStatus?: "winning" | "outbid" | "none";
  /** Postgres `now()` when timer fields were read (UTC ISO). */
  serverTime?: string;
};

export type SnapshotOptions = {
  audience: "admin" | "bidder" | "client";
  bidderId?: number | null;
  visibility?: AuctionVisibility | null;
};

/** One snapshot per room, all projected from a single database read. */
export type BroadcastSnapshots = {
  admin: LiveAuctionSnapshot;
  bidder: LiveAuctionSnapshot;
  client: LiveAuctionSnapshot;
};

export type LiveAuctionListItem = {
  id: number;
  auctionNumber: string | null;
  clientId: number | null;
  clientName: string | null;
  auctionDate: string;
  lotCount: number;
  liveState: LiveState;
  // True (bidder view only) when the auction has an active T&C doc the bidder
  // hasn't accepted — they must accept before entering/bidding.
  tncRequired: boolean;
  // Bidder view only: the lot ids this bidder is attached to. `null` means all
  // lots (admin view, or an auction-wide map). Used to filter the shared live
  // snapshot so a bidder never sees lots they aren't mapped to.
  attachedLotIds: number[] | null;
};

function computeYourStatus(
  winnerBidderId: number | null,
  bidderId?: number | null,
  hasLiveBid = false,
): "winning" | "outbid" | "none" {
  if (bidderId == null) return "none";
  return participantStanding({ winnerBidderId, bidderId, hasLiveBid });
}

/**
 * True while bidders must not see a lot's start price or bid limit: an
 * auction whose sealed-bid window has not closed yet. Matches
 * SealedBidService.myView, which never returns either bound. Expects the
 * auction aliased `a`. Open live (English) bidding after the window keeps
 * showing the start price, as before.
 */
export const sealedPhaseSql = sql`(
  a.is_sealed_bid
  AND a.sealed_bid_date IS NOT NULL
  AND a.sealed_bid_start_time IS NOT NULL
  AND a.sealed_bid_end_time IS NOT NULL
  AND ((a.sealed_bid_date::date + a.sealed_bid_end_time) AT TIME ZONE 'Asia/Kolkata') > now()
)`;

/** Bidder copy of the lot "other details" with sealed-phase bounds withheld. */
export function projectLotDetailsForBidder<
  T extends { startBidPrice: number | null; bidLimit: number | null },
>(details: T, sealedPhase: boolean): T {
  if (!sealedPhase) return details;
  return { ...details, startBidPrice: null, bidLimit: null };
}

/**
 * Admin and client keep winner identity (client is scoped to their companies)
 * and the real winning amount. Bidder never receives winner names/ids, and
 * never receives the winning amount either when `isRankBased` — `yourRank`/
 * `yourStatus` replace it there instead. During the sealed-bid phase
 * (`sealedPhase`) the bidder also gets no start price, bid limit or
 * `currentBid` (which is the start price until someone bids). Relative standing
 * (`yourStatus`) is bidder-only; `yourRank` is only ever populated for the
 * bidder's own personal snapshot (see getSnapshot), so admin/client payloads
 * never carry a real value for it regardless of this projection.
 */
export function projectLotForAudience(
  lot: LiveLot,
  audience: "admin" | "bidder" | "client",
  bidderId?: number | null,
  hasLiveBid = false,
  isRankBased = false,
  sealedPhase = false,
): LiveLot {
  if (audience === "admin") return lot;
  if (audience === "client") {
    const projected: LiveLot = { ...lot };
    delete projected.yourStatus;
    return projected;
  }
  const projected: LiveLot = {
    ...lot,
    winnerBidderId: null,
    winnerBidderName: null,
  };
  if (isRankBased) {
    projected.currentBid = null;
  }
  if (sealedPhase) {
    projected.startBidPrice = null;
    projected.bidLimit = null;
    projected.currentBid = null;
  }
  if (bidderId == null) {
    delete projected.yourStatus;
    return projected;
  }
  projected.yourStatus = computeYourStatus(
    lot.winnerBidderId,
    bidderId,
    hasLiveBid,
  );
  return projected;
}

/** Same projection rules as lots, for post-bid delta pushes. */
export function projectDeltaForAudience(
  delta: LiveLotDelta,
  audience: "admin" | "bidder" | "client",
  bidderId?: number | null,
  hasLiveBid = false,
): LiveLotDelta {
  if (audience === "admin") return delta;
  if (audience === "client") {
    const projected: LiveLotDelta = { ...delta };
    delete projected.yourStatus;
    return projected;
  }
  const projected: LiveLotDelta = {
    ...delta,
    winnerBidderId: null,
    winnerBidderName: null,
  };
  if (delta.isRankBased === true || delta.sealedPhase === true) {
    projected.currentBid = null;
  }
  if (bidderId == null) {
    delete projected.yourStatus;
    return projected;
  }
  projected.yourStatus = computeYourStatus(
    delta.winnerBidderId,
    bidderId,
    hasLiveBid,
  );
  return projected;
}

// firstStartSec / lastEndSec are seconds-from-now (negative = already past).
export function computeLiveState(
  firstStartSec: number | null,
  lastEndSec: number | null,
): LiveState {
  if (lastEndSec != null && lastEndSec <= 0) return "ended";
  if (firstStartSec != null && firstStartSec > 0) return "upcoming";
  return "live";
}

type SnapshotAuctionRow = {
  id: number;
  auction_number: string | null;
  auction_type: string | null;
  client_name: string | null;
  status: string;
  is_rank_based: boolean | null;
  /** See sealedPhaseSql. */
  sealed_phase: boolean | null;
  server_time: string;
};

type SnapshotLotRow = {
  id: number;
  lot_number: string | null;
  display_order: string | null;
  title: string | null;
  material_location: string | null;
  quantity: string | null;
  uom: string | null;
  start_bid_price: string | null;
  bid_increment: string | null;
  current_bid: string | null;
  winner_bidder_id: number | null;
  winner_bidder_name: string | null;
  starts_at: string | null;
  ends_at: string | null;
  start_left_sec: number;
  time_left_sec: number;
  /**
   * Direct timestamp comparison (effective_end <= now()), not derived from
   * the floored/rounded time_left_sec — a lot with sub-second time left must
   * never read as closed before its true end instant.
   */
  is_closed: boolean;
  last_bid_extension_count: number;
  is_reopened: boolean;
  bid_count: number;
  bidder_count: number;
  sbp_plus_increment: boolean | null;
  bid_limit: string | null;
  live_rev: number;
  server_time: string;
};

/**
 * Everything a snapshot needs that does not depend on the audience. Loaded once
 * so the three room payloads are projections of a single read rather than three
 * identical trips to the database.
 */
type SnapshotBase = {
  auction: SnapshotAuctionRow;
  rows: SnapshotLotRow[];
  serverTime: string;
  liveState: LiveState;
};

// Absolute lot time = auction_date (date) + lot time-of-day, interpreted as IST.
// time-left is computed server-side so all clients share one authoritative clock
// regardless of their browser timezone.
export class LiveAuctionService {
  private async loadSnapshotBase(
    auctionId: number,
  ): Promise<SnapshotBase | null> {
    const auctionRes = await db.execute<SnapshotAuctionRow>(sql`
        SELECT a.auction_id AS id, a.auction_number, a.auction_type,
               c.company_name AS client_name, a.status, a.is_rank_based,
               ${sealedPhaseSql} AS sealed_phase,
               to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS server_time
        FROM auctions a
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.auction_id = ${auctionId}
        LIMIT 1
      `);
    const auction = auctionRes.rows[0];
    if (!auction) return null;

    const lotRes = await db.execute<SnapshotLotRow>(sql`
        SELECT l.id, l.lot_number, l.display_order, l.quantity, u.code AS uom,
               a.is_start_bid_price_plus_increment AS sbp_plus_increment,
               ml.name AS material_location,
               (SELECT COALESCE(NULLIF(it.name, ''), NULLIF(ali.material_name, ''), ali.material_description)
                  FROM auction_lot_items ali
                  LEFT JOIN items it ON it.id = ali.item_id
                  WHERE ali.lot_id = l.id AND ali.is_active
                  ORDER BY ali.id LIMIT 1) AS title,
               l.start_bid_price, l.bid_increment, l.bid_limit,
               COALESCE(l.winning_amount, l.start_bid_price) AS current_bid,
               l.winner_bidder_id, wb.company_name AS winner_bidder_name,
               l.last_bid_extension_count, l.is_reopened,
               l.bid_count, l.bidder_count, l.live_rev,
               to_char((a.auction_date::date + l.start_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at,
               to_char(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)), 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_at,
               FLOOR(EXTRACT(EPOCH FROM (((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now())))::int AS start_left_sec,
               FLOOR(EXTRACT(EPOCH FROM ((COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata')) - now())))::int AS time_left_sec,
               (
                 (COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata') <= now())
                 AND NOT (${NO_BID_EXTENSION_PENDING})
               ) AS is_closed,
               to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS server_time
        FROM auction_lots l
        JOIN auctions a ON a.auction_id = l.auction_id
        LEFT JOIN uoms u ON u.id = l.uom_id
        LEFT JOIN material_locations ml ON ml.id = l.material_location_id
        LEFT JOIN bidders wb ON wb.id = l.winner_bidder_id
        WHERE l.auction_id = ${auctionId} AND l.is_active = true
        ORDER BY l.display_order NULLS LAST, l.id
      `);

    // liveState is computed from all active lots (pre-visibility filter) so
    // an auction doesn't flip to "ended" just because a bidder can't see open lots.
    const firstStart = lotRes.rows.length
      ? Math.min(...lotRes.rows.map((r) => r.start_left_sec))
      : null;
    const lastEnd = lotRes.rows.length
      ? Math.max(...lotRes.rows.map((r) => r.time_left_sec))
      : null;

    return {
      auction,
      rows: lotRes.rows,
      // Same Postgres `now()` as timeLeftSec — never Node's clock. The client
      // still anchors countdowns to Date.now() on arrival so a host/browser
      // skew cannot inflate remaining time.
      serverTime: lotRes.rows[0]?.server_time ?? auction.server_time,
      liveState: computeLiveState(firstStart, lastEnd),
    };
  }

  /** Project one loaded base into the payload a single audience should receive. */
  private projectSnapshot(
    base: SnapshotBase,
    opts: SnapshotOptions,
    liveBidByLot: Map<number, boolean>,
    seq: number,
    personalRank?: PersonalRank,
  ): LiveAuctionSnapshot {
    const lotIds = opts.visibility?.lotIds;
    const rows =
      lotIds != null ? base.rows.filter((r) => lotIds.has(r.id)) : base.rows;

    const lots: LiveLot[] = rows.map((r) => {
      const lot: LiveLot = {
        id: r.id,
        lotNumber: r.lot_number,
        displayOrder: r.display_order != null ? Number(r.display_order) : null,
        title: r.title,
        materialLocation: r.material_location,
        quantity: r.quantity != null ? Number(r.quantity) : null,
        uom: r.uom,
        startBidPrice: Number(r.start_bid_price ?? 0),
        bidIncrement: Number(r.bid_increment ?? 0),
        currentBid: Number(r.current_bid ?? r.start_bid_price ?? 0),
        winnerBidderId: r.winner_bidder_id,
        winnerBidderName: r.winner_bidder_name,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        startLeftSec: r.start_left_sec,
        timeLeftSec: Math.max(0, r.time_left_sec),
        notStarted: r.start_left_sec > 0,
        closed: r.is_closed === true,
        reopened: r.is_reopened === true,
        lastBidExtensionCount: r.last_bid_extension_count ?? 0,
        bidCount: r.bid_count ?? 0,
        bidderCount: r.bidder_count ?? 0,
        bidLimit: r.bid_limit != null ? Number(r.bid_limit) : null,
        sbpPlusIncrement: r.sbp_plus_increment === true,
        rev: r.live_rev ?? 0,
      };
      if (personalRank) {
        // null = rank-based lot this bidder hasn't bid on yet.
        const mine = personalRank.get(r.id);
        lot.yourRank = mine?.rank ?? null;
        lot.yourBid = mine?.best ?? null;
      }
      return projectLotForAudience(
        lot,
        opts.audience,
        opts.bidderId,
        liveBidByLot.get(r.id) === true,
        base.auction.is_rank_based === true,
        base.auction.sealed_phase === true,
      );
    });

    return {
      auction: {
        id: base.auction.id,
        auctionNumber: base.auction.auction_number,
        auctionType: base.auction.auction_type,
        clientName: base.auction.client_name,
        status: base.auction.status,
        liveState: base.liveState,
        isRankBased: base.auction.is_rank_based === true,
      },
      lots,
      serverTime: base.serverTime,
      seq,
    };
  }

  async getSnapshot(
    auctionId: number,
    opts: SnapshotOptions = { audience: "admin" },
  ): Promise<LiveAuctionSnapshot | null> {
    return timedLive(`getSnapshot:${auctionId}`, async () => {
      const base = await this.loadSnapshotBase(auctionId);
      if (!base) return null;

      const liveBidByLot = new Map<number, boolean>();
      if (opts.audience === "bidder" && opts.bidderId != null) {
        const partRes = await db.execute<{ lot_id: number }>(sql`
          SELECT DISTINCT lot_id FROM (
            SELECT ab.lot_id
            FROM auction_bids ab
            INNER JOIN auction_lots al ON al.id = ab.lot_id
            WHERE ab.bidder_id = ${opts.bidderId} AND al.auction_id = ${auctionId}
            UNION
            SELECT pb.lot_id
            FROM auction_proxy_bids pb
            INNER JOIN auction_lots al ON al.id = pb.lot_id
            WHERE pb.bidder_id = ${opts.bidderId} AND pb.is_active = true
              AND al.auction_id = ${auctionId}
          ) t
        `);
        for (const r of partRes.rows) liveBidByLot.set(r.lot_id, true);
      }

      // This bidder's own rank and best bid per lot. Personal snapshot only;
      // shared room payloads omit both so a merge never wipes them.
      let personalRank: PersonalRank | undefined;
      if (
        opts.audience === "bidder" &&
        opts.bidderId != null &&
        base.auction.is_rank_based === true
      ) {
        personalRank = new Map();
        const rankings = await loadRankings(
          db,
          sql`lot_id IN (SELECT id FROM auction_lots WHERE auction_id = ${auctionId})`,
          bidDirectionFor(base.auction.auction_type),
          opts.bidderId,
        );
        for (const r of rankings) {
          personalRank.set(r.lotId, { rank: r.rank, best: r.best });
        }
      }

      return this.projectSnapshot(
        base,
        opts,
        liveBidByLot,
        nextAuctionSeq(auctionId),
        personalRank,
      );
    });
  }

  /**
   * The three room payloads for one broadcast, from a single read. Callers used
   * to ask for admin, bidder and client separately, which ran the same two
   * queries three times per resync tick and per anti-snipe extension.
   *
   * All three carry the same `seq` because they describe the same moment; a
   * client only ever subscribes to one room, so the value stays monotonic.
   */
  async getBroadcastSnapshots(
    auctionId: number,
  ): Promise<BroadcastSnapshots | null> {
    return timedLive(`getBroadcastSnapshots:${auctionId}`, async () => {
      const base = await this.loadSnapshotBase(auctionId);
      if (!base) return null;
      // No bidderId on a shared room payload, so per-bidder standing never
      // applies here and the participation lookup is not needed.
      const noStanding = new Map<number, boolean>();
      const seq = nextAuctionSeq(auctionId);
      return {
        admin: this.projectSnapshot(base, { audience: "admin" }, noStanding, seq),
        bidder: this.projectSnapshot(base, { audience: "bidder" }, noStanding, seq),
        client: this.projectSnapshot(base, { audience: "client" }, noStanding, seq),
      };
    });
  }

  /**
   * Cheap single-lot state (winning / winner / counts / timers) for the post-bid
   * delta push. O(1) in the number of lots — unlike getSnapshot, which
   * recomputes every lot of the auction.
   */
  async lotDelta(
    auctionId: number,
    lotId: number,
  ): Promise<LiveLotDelta | null> {
    return timedLive(`lotDelta:${lotId}`, async () => {
      const res = await db.execute<{
        current_bid: string | null;
        winner_bidder_id: number | null;
        winner_bidder_name: string | null;
        bid_count: number;
        bidder_count: number;
        ends_at: string | null;
        start_left_sec: number;
        time_left_sec: number;
        is_closed: boolean;
        last_bid_extension_count: number;
        live_rev: number;
        server_time: string;
        is_rank_based: boolean | null;
        sealed_phase: boolean | null;
      }>(sql`
        SELECT COALESCE(l.winning_amount, l.start_bid_price) AS current_bid,
               l.winner_bidder_id, wb.company_name AS winner_bidder_name,
               l.bid_count, l.bidder_count, l.last_bid_extension_count, l.live_rev,
               to_char(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)), 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_at,
               FLOOR(EXTRACT(EPOCH FROM (((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now())))::int AS start_left_sec,
               FLOOR(EXTRACT(EPOCH FROM ((COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata')) - now())))::int AS time_left_sec,
               (
                 (COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata') <= now())
                 AND NOT (${NO_BID_EXTENSION_PENDING})
               ) AS is_closed,
               to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS server_time,
               a.is_rank_based,
               ${sealedPhaseSql} AS sealed_phase
        FROM auction_lots l
        JOIN auctions a ON a.auction_id = l.auction_id
        LEFT JOIN bidders wb ON wb.id = l.winner_bidder_id
        WHERE l.id = ${lotId}
      `);
      const r = res.rows[0];
      if (!r) return null;
      return {
        auctionId,
        lotId,
        currentBid: Number(r.current_bid ?? 0),
        winnerBidderId: r.winner_bidder_id,
        winnerBidderName: r.winner_bidder_name,
        bidCount: r.bid_count ?? 0,
        bidderCount: r.bidder_count ?? 0,
        seq: nextAuctionSeq(auctionId),
        rev: r.live_rev ?? 0,
        timeLeftSec: Math.max(0, r.time_left_sec),
        startLeftSec: r.start_left_sec,
        endsAt: r.ends_at,
        lastBidExtensionCount: r.last_bid_extension_count ?? 0,
        closed: r.is_closed === true,
        notStarted: r.start_left_sec > 0,
        serverTime: r.server_time,
        isRankBased: r.is_rank_based === true,
        sealedPhase: r.sealed_phase === true,
      };
    });
  }

  // When `bidderId` is given (i.e. a bidder is asking), restrict the list to
  // auctions the bidder is actually registered for, so the bidder's Live
  // Monitor only shows auctions they can bid on. Admins pass null → global list.
  // `clientUserId` scopes the list to that portal user's linked companies.
  async listLive(
    bidderId?: number | null,
    clientUserId?: number | null,
  ): Promise<LiveAuctionListItem[]> {
    const scopedBidderId = clientUserId != null ? null : bidderId;
    const bidderFilter =
      scopedBidderId != null
        ? sql`AND EXISTS (
            SELECT 1 FROM auction_lot_bidder_maps m
            WHERE m.auction_id = a.auction_id AND m.bidder_id = ${scopedBidderId}
              AND m.is_active = true
          )`
        : sql``;
    const clientFilter =
      clientUserId != null
        ? sql`AND a.client_id IN (
            SELECT uc.client_id FROM user_clients uc
            WHERE uc.user_id = ${clientUserId} AND uc.is_active = true
          )`
        : sql``;
    // Per-auction T&C gate for the bidder view (false for admins and clients).
    const tncRequiredExpr =
      scopedBidderId != null
        ? sql`(EXISTS (SELECT 1 FROM auction_documents d
                 WHERE d.auction_id = a.auction_id AND d.document_type_id = 2 AND d.is_active)
               AND NOT EXISTS (SELECT 1 FROM auction_tnc_acceptances t
                 WHERE t.auction_id = a.auction_id AND t.bidder_id = ${scopedBidderId}))`
        : sql`false`;
    // Bidder's attached lot ids per auction: NULL when they have an auction-wide
    // map (all lots) or for the admin/client view; otherwise the specific mapped lots.
    const attachedLotIdsExpr =
      scopedBidderId != null
        ? sql`(CASE
                 WHEN EXISTS (
                   SELECT 1 FROM auction_lot_bidder_maps m
                   WHERE m.auction_id = a.auction_id AND m.bidder_id = ${scopedBidderId}
                     AND m.is_active = true AND m.lot_id IS NULL
                 ) THEN NULL
                 ELSE (
                   SELECT array_agg(DISTINCT m.lot_id)
                   FROM auction_lot_bidder_maps m
                   WHERE m.auction_id = a.auction_id AND m.bidder_id = ${scopedBidderId}
                     AND m.is_active = true AND m.lot_id IS NOT NULL
                 )
               END)`
        : sql`NULL::int[]`;
    const res = await db.execute<{
      id: number;
      auction_number: string | null;
      client_id: number | null;
      client_name: string | null;
      auction_date: string;
      lot_count: number;
      first_start_sec: number | null;
      last_end_sec: number | null;
      tnc_required: boolean;
      attached_lot_ids: number[] | null;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number,
             a.client_id, c.company_name AS client_name,
             to_char(a.auction_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS auction_date,
             ${tncRequiredExpr} AS tnc_required,
             ${attachedLotIdsExpr} AS attached_lot_ids,
             (SELECT count(*) FROM auction_lots l
                WHERE l.auction_id = a.auction_id AND l.is_active)::int AS lot_count,
             (SELECT EXTRACT(EPOCH FROM ((min(a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now()))::int
                FROM auction_lots l WHERE l.auction_id = a.auction_id AND l.is_active) AS first_start_sec,
             (SELECT EXTRACT(EPOCH FROM ((max(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'))) - now()))::int
                FROM auction_lots l WHERE l.auction_id = a.auction_id AND l.is_active) AS last_end_sec
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.status = 'published' AND a.is_active = true
        -- Only today's auctions (IST), so the monitor shows today's schedule.
        AND a.auction_date::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
        -- Live only: earliest active lot start has already passed (staggered
        -- multi-lot auctions appear as soon as the first lot starts).
        AND COALESCE(
          (SELECT min(a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata'
             FROM auction_lots l WHERE l.auction_id = a.auction_id AND l.is_active) <= now(),
          false
        )
        -- Exclude auctions that have fully ended — kept if the latest lot end
        -- is still in the future (or there are no active lots yet).
        AND COALESCE(
          (SELECT max(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'))
             FROM auction_lots l WHERE l.auction_id = a.auction_id AND l.is_active) > now(),
          true
        )
        ${bidderFilter}
        ${clientFilter}
      ORDER BY a.auction_date DESC
      LIMIT 100
    `);
    return res.rows.map((r) => ({
      id: r.id,
      auctionNumber: r.auction_number,
      clientId: r.client_id,
      clientName: r.client_name,
      auctionDate: r.auction_date,
      lotCount: r.lot_count,
      liveState: computeLiveState(r.first_start_sec, r.last_end_sec),
      tncRequired: r.tnc_required === true,
      attachedLotIds: r.attached_lot_ids ?? null,
    }));
  }

  // All bids on a lot, newest first. Rank-based ledgers aren't monotonic in
  // amount, so time is the only order that reads as a history.
  async lotBids(lotId: number) {
    const res = await db.execute<{
      id: number;
      bidder_id: number;
      bidder_name: string | null;
      amount: string;
      is_proxy: boolean;
      proxy_amount: string | null;
      ip: string | null;
      placed_at: string | null;
    }>(sql`
      SELECT b.id, b.bidder_id, bd.company_name AS bidder_name,
             b.amount, b.is_proxy, b.proxy_amount, b.ip,
             to_char(b.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS placed_at
      FROM auction_bids b
      LEFT JOIN bidders bd ON bd.id = b.bidder_id
      WHERE b.lot_id = ${lotId}
      ORDER BY b.created_at DESC, b.id DESC
    `);
    return res.rows.map((r) => ({
      id: r.id,
      bidderId: r.bidder_id,
      bidderName: r.bidder_name,
      amount: Number(r.amount),
      isProxy: r.is_proxy === true,
      proxyAmount: r.proxy_amount != null ? Number(r.proxy_amount) : null,
      ip: r.ip,
      placedAt: r.placed_at,
    }));
  }

  // Distinct bidders who have placed a bid on the lot (matches the legacy
  // "No. of Bidders" semantics), with each one's best bid and bid count.
  async lotBidders(lotId: number) {
    // Only bidders who have actually placed a bid on the lot. The bidder map
    // (auction-wide or per-lot) restricts to active participants, and the inner
    // join on auction_bids drops anyone who hasn't bid.
    const typeRes = await db.execute<{
      auction_type: string | null;
      is_rank_based: boolean | null;
    }>(sql`
      SELECT a.auction_type, a.is_rank_based
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      WHERE l.id = ${lotId}
      LIMIT 1
    `);
    const reverse = typeRes.rows[0]?.auction_type === "reverse";
    const bestExpr = reverse ? sql`min(b.amount)` : sql`max(b.amount)`;
    const amountOrder = reverse ? sql`ASC` : sql`DESC`;
    const res = await db.execute<{
      bidder_id: number;
      bidder_name: string | null;
      bids: number;
      best_amount: string | null;
      last_bid_at: string | null;
      is_winner: boolean;
    }>(sql`
      SELECT ab.bidder_id, bd.company_name AS bidder_name,
             count(b.id)::int AS bids,
             ${bestExpr} AS best_amount,
             to_char(max(b.created_at), 'YYYY-MM-DD"T"HH24:MI:SS.US') AS last_bid_at,
             bool_or(b.bidder_id = ab.winner_bidder_id) AS is_winner
      FROM (
        SELECT DISTINCT m.bidder_id, l.id AS lot_id, l.winner_bidder_id
        FROM auction_lots l
        JOIN auction_lot_bidder_maps m ON m.auction_id = l.auction_id
          AND m.is_active = true
          AND (m.lot_id IS NULL OR m.lot_id = l.id)
        WHERE l.id = ${lotId}
      ) ab
      LEFT JOIN bidders bd ON bd.id = ab.bidder_id
      JOIN auction_bids b
        ON b.lot_id = ab.lot_id AND b.bidder_id = ab.bidder_id
      GROUP BY ab.bidder_id, bd.company_name
      -- Same tie order as loadRankings: whoever committed to the best amount
      -- earliest (an auto-bid commits at its proxy's set time).
      ORDER BY ${bestExpr} ${amountOrder} NULLS LAST,
               (array_agg(COALESCE(b.committed_at, b.created_at)
                  ORDER BY b.amount ${amountOrder}, COALESCE(b.committed_at, b.created_at) ASC, b.id ASC))[1] ASC,
               (array_agg(b.id
                  ORDER BY b.amount ${amountOrder}, COALESCE(b.committed_at, b.created_at) ASC, b.id ASC))[1] ASC
    `);
    const rows = res.rows.map((r) => ({
      bidderId: r.bidder_id,
      bidderName: r.bidder_name,
      bids: r.bids,
      bestAmount: r.best_amount != null ? Number(r.best_amount) : null,
      lastBidAt: r.last_bid_at,
      isWinner: r.is_winner === true,
    }));
    if (typeRes.rows[0]?.is_rank_based !== true) {
      return rows.map((r) => ({ ...r, rank: null }));
    }
    // Same ranking the bidder sees live, so the numbers always agree.
    const rankings = await loadRankings(
      db,
      sql`lot_id = ${lotId}`,
      bidDirectionFor(typeRes.rows[0]?.auction_type),
    );
    return withBidderRanks(rows, rankings);
  }

  // Static "other details" for a lot, mirroring the legacy other-info popup.
  // `auctionId` / `sealedPhase` are for the route's bidder gate and masking
  // (see projectLotDetailsForBidder) and are stripped before responding.
  async lotDetails(lotId: number) {
    const res = await db.execute<{
      id: number;
      auction_id: number;
      sealed_phase: boolean | null;
      lot_number: string | null;
      quantity: string | null;
      uom: string | null;
      start_bid_price: string | null;
      bid_increment: string | null;
      bid_limit: string | null;
      plant_location: string | null;
      material_location: string | null;
      material_lifting_days: number | null;
      loading_scope: string | null;
      gst_percentage: string | null;
      tcs_percentage: string | null;
      starts_at: string | null;
      ends_at: string | null;
      last_bid_extension_count: number;
    }>(sql`
      SELECT l.id, l.auction_id, ${sealedPhaseSql} AS sealed_phase,
             l.lot_number, l.quantity, u.code AS uom,
             l.start_bid_price, l.bid_increment, l.bid_limit,
             pl.name AS plant_location, ml.name AS material_location,
             l.material_lifting_days, l.loading_scope,
             l.gst_percentage, l.tcs_percentage,
             to_char((a.auction_date::date + l.start_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at,
             to_char(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)), 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_at,
             l.last_bid_extension_count
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN plant_locations pl ON pl.id = l.plant_location_id
      LEFT JOIN material_locations ml ON ml.id = l.material_location_id
      WHERE l.id = ${lotId}
      LIMIT 1
    `);
    const r = res.rows[0];
    if (!r) return null;

    // The line items that make up the lot (material name, description, qty).
    const itemsRes = await db.execute<{
      id: number;
      item_name: string | null;
      material_name: string | null;
      material_description: string | null;
      quantity: string | null;
      uom: string | null;
    }>(sql`
      SELECT ali.id,
             it.name AS item_name,
             ali.material_name,
             ali.material_description,
             ali.quantity,
             COALESCE(iu.code, lu.code) AS uom
      FROM auction_lot_items ali
      LEFT JOIN items it ON it.id = ali.item_id
      LEFT JOIN uoms iu ON iu.id = it.uom_id
      LEFT JOIN auction_lots l ON l.id = ali.lot_id
      LEFT JOIN uoms lu ON lu.id = l.uom_id
      WHERE ali.lot_id = ${lotId} AND ali.is_active = true
      ORDER BY ali.id
    `);

    return {
      auctionId: r.auction_id,
      sealedPhase: r.sealed_phase === true,
      details: {
      id: r.id,
      lotNumber: r.lot_number,
      quantity: r.quantity != null ? Number(r.quantity) : null,
      uom: r.uom,
      startBidPrice: r.start_bid_price != null ? Number(r.start_bid_price) : null,
      bidIncrement: r.bid_increment != null ? Number(r.bid_increment) : null,
      bidLimit: r.bid_limit != null ? Number(r.bid_limit) : null,
      plantLocation: r.plant_location,
      materialLocation: r.material_location,
      materialLiftingDays: r.material_lifting_days,
      loadingScope: r.loading_scope,
      gstPercentage: r.gst_percentage != null ? Number(r.gst_percentage) : null,
      tcsPercentage: r.tcs_percentage != null ? Number(r.tcs_percentage) : null,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      lastBidExtensionCount: r.last_bid_extension_count ?? 0,
      items: itemsRes.rows.map((i) => ({
        id: i.id,
        itemName: i.item_name || i.material_name,
        materialName: i.material_name,
        materialDescription: i.material_description,
        quantity: i.quantity != null ? Number(i.quantity) : null,
        uom: i.uom,
      })),
      },
    };
  }
}

export const liveAuctionService = new LiveAuctionService();

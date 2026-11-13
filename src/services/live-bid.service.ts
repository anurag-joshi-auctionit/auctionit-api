import { eq, sql } from "drizzle-orm";
import { LiveBidMessages } from "@auctionit/messages/auctions";
import {
  bidDirectionFor,
  manualBidAmountError,
  rankBidAmountError,
  rankBoundsLot,
  type BidBoundsLot,
  type BidDirection,
} from "@auctionit/lib/live-bid-bounds";
import { loadRankings } from "../lib/auctions/rank.js";
import { db } from "../db/index.js";
import { auctionBidLogs } from "../db/schema/auction-bid-logs.js";
import { auctionBids } from "../db/schema/auction-bids.js";
import { auctionLots } from "../db/schema/auction-lots.js";
import {
  settleProxies,
  type Contender,
} from "../lib/auctions/proxy-settle.js";
import { shouldLastBidExtension } from "../lib/auctions/last-bid-extension.js";
import {
  shouldStagger,
} from "../lib/auctions/stagger.js";
import { applyCascadeFromAnchor } from "./lot-stagger.service.js";
import { normalizeClientIp } from "../lib/auctions/ip-restriction.js";
import { bidderGateError } from "../lib/auctions/bidder-gate.js";

export type BidStanding = "winning" | "outbid";

export type ExtendResult = {
  extended: boolean;
};

/**
 * Bidders whose standing this write could have changed: the bidder who acted,
 * whoever held the lot before, whoever holds it now, and any proxy the
 * settlement moved. Lets the broadcast skip rebuilding the lot's participant
 * list from its whole bid history.
 */
export type AffectedBidderIds = number[];

export type BidResult =
  | {
      accepted: true;
      amount: number;
      /** Null for rank-based auctions — the winning amount is never sent to the bidder. */
      finalAmount: number | null;
      yourStatus: BidStanding;
      rev: number;
      extended: boolean;
      affectedBidderIds: AffectedBidderIds;
      /** Rank-based auctions only: this bidder's live position on the lot. */
      yourRank: number | null;
      /** Rank-based auctions only: this bidder's own best bid on the lot. */
      yourBid: number | null;
    }
  | { accepted: false; reason: string };

export type ProxyResult =
  | {
      accepted: true;
      maxAmount: number;
      /** Null for rank-based auctions — the winning amount is never sent to the bidder. */
      finalAmount: number | null;
      yourStatus: BidStanding;
      rev: number;
      extended: boolean;
      affectedBidderIds: AffectedBidderIds;
      /** Rank-based auctions only: this bidder's live position on the lot. */
      yourRank: number | null;
      /** Rank-based auctions only: this bidder's own best bid on the lot. */
      yourBid: number | null;
    }
  | { accepted: false; reason: string };

/** Standing after proxy settlement — bidder always participated, so never "none". */
function standingAfterSettle(
  winnerBidderId: number | null,
  bidderId: number,
): BidStanding {
  return winnerBidderId === bidderId ? "winning" : "outbid";
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Money is compared in integer paise to avoid float rounding on the
// multiple-of-increment / equality checks.
function paise(n: number): number {
  return Math.round(n * 100);
}

function outbidRejection(
  _auctionType: string | null | undefined,
  direction: BidDirection,
): string {
  return direction === 1
    ? LiveBidMessages.OUTBID_EQUAL_OR_HIGHER
    : LiveBidMessages.OUTBID_EQUAL_OR_LOWER;
}

/** Keep denormalized lot bid stats in sync with the auction_bids ledger. */
async function bumpLotBidStats(
  tx: Tx,
  lotId: number,
  bidderId: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE auction_lots SET
      live_rev = live_rev + 1,
      bid_count = bid_count + 1,
      bidder_count = CASE
        WHEN NOT (${bidderId} = ANY(bidder_ids)) THEN bidder_count + 1
        ELSE bidder_count
      END,
      bidder_ids = CASE
        WHEN NOT (${bidderId} = ANY(bidder_ids))
          THEN array_append(bidder_ids, ${bidderId})
        ELSE bidder_ids
      END
    WHERE id = ${lotId}
  `);
}

/** Append-only attempt audit — same txn as the bid so accept/reject stay atomic. */
async function insertBidLog(
  tx: Tx,
  row: {
    auctionId: number;
    lotId: number;
    bidderId: number;
    userId: number;
    amount: number;
    isProxy: boolean;
    proxyAmount?: number | null;
    ip?: string | null;
    isAccepted: boolean;
    rejectReason?: string | null;
  },
): Promise<void> {
  await tx.insert(auctionBidLogs).values({
    auctionId: row.auctionId,
    lotId: row.lotId,
    bidderId: row.bidderId,
    userId: row.userId,
    amount: row.amount.toFixed(2),
    isProxy: row.isProxy,
    proxyAmount:
      row.proxyAmount != null ? row.proxyAmount.toFixed(2) : null,
    ip: row.ip ?? null,
    isAccepted: row.isAccepted,
    rejectReason: row.rejectReason ?? null,
    createdAt: sql`clock_timestamp()`,
  });
}

export class LiveBidService {
  /**
   * Places a bid on a forward (English) lot. The lot row is locked FOR UPDATE so
   * concurrent bids on the same lot are serialized — the second of two equal
   * bids sees the updated winning amount and is cleanly rejected as "outbid", rather than
   * the legacy optimistic race.
   */
  async placeBid(input: {
    auctionId: number;
    lotId: number;
    bidderId: number;
    userId: number;
    amount: number;
    ip?: string | null;
  }): Promise<BidResult> {
    const ip = normalizeClientIp(input.ip);
    return db.transaction(async (tx) => {
      // Log once the lot row is known (valid FKs). Skip when missing lot.
      let canLog = false;
      const reject = async (reason: string): Promise<BidResult> => {
        if (canLog) {
          await insertBidLog(tx, {
            auctionId: input.auctionId,
            lotId: input.lotId,
            bidderId: input.bidderId,
            userId: input.userId,
            amount: input.amount,
            isProxy: false,
            proxyAmount: null,
            ip,
            isAccepted: false,
            rejectReason: reason,
          });
        }
        return { accepted: false, reason };
      };

      const lotRes = await tx.execute<{
        id: number;
        auction_id: number;
        is_active: boolean;
        start_bid_price: string | null;
        bid_increment: string | null;
        bid_limit: string | null;
        winning_amount: string | null;
        winner_bidder_id: number | null;
        display_order: string | null;
        last_bid_extension_count: number;
        effective_end: string | null;
        auction_type: string | null;
        sbp_plus_increment_enabled: boolean | null;
        time_to_start_sec: number;
        time_left_sec: number;
        is_last_bid_extension: boolean | null;
        last_bid_extension_window: number | null;
        last_bid_extension_interval: number | null;
        last_bid_extension_count_max: number | null;
        is_staggered: boolean | null;
        stagger_interval: number | null;
        tnc_blocked: boolean;
        ip_restriction_enabled: boolean | null;
        is_rank_based: boolean | null;
        is_reopened: boolean;
      }>(sql`
        SELECT l.id, l.auction_id, l.is_active,
               l.start_bid_price, l.bid_increment, l.bid_limit, l.winning_amount,
               l.winner_bidder_id,
               l.display_order, l.last_bid_extension_count,
               to_char(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)), 'YYYY-MM-DD"T"HH24:MI:SS') AS effective_end,
               a.auction_type, a.is_start_bid_price_plus_increment AS sbp_plus_increment_enabled,
               a.ip_address_restriction_enabled AS ip_restriction_enabled,
               a.is_rank_based, l.is_reopened,
               EXTRACT(EPOCH FROM (((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now()))::int AS time_to_start_sec,
               EXTRACT(EPOCH FROM ((COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata')) - now()))::int AS time_left_sec,
               c.is_last_bid_extension, c.last_bid_extension_window, c.last_bid_extension_interval, c.last_bid_extension_count_max,
               COALESCE(a.is_staggered, c.is_staggered) AS is_staggered,
               c.stagger_interval,
               -- T&C gate: blocked when the auction has an active T&C document and
               -- this bidder hasn't accepted it yet.
               (EXISTS (SELECT 1 FROM auction_documents d
                  WHERE d.auction_id = a.auction_id AND d.document_type_id = 2 AND d.is_active)
                AND NOT EXISTS (SELECT 1 FROM auction_tnc_acceptances t
                  WHERE t.auction_id = a.auction_id AND t.bidder_id = ${input.bidderId})) AS tnc_blocked
        FROM auction_lots l
        JOIN auctions a ON a.auction_id = l.auction_id
        JOIN clients c ON c.id = a.client_id
        WHERE l.id = ${input.lotId}
        FOR UPDATE OF l
      `);
      const lot = lotRes.rows[0];
      if (!lot) return reject(LiveBidMessages.LOT_NOT_FOUND);
      canLog = true;
      if (!lot.is_active) return await reject(LiveBidMessages.LOT_NOT_FOUND);
      if (lot.auction_id !== input.auctionId)
        return await reject(LiveBidMessages.LOT_AUCTION_MISMATCH);
      if (lot.auction_type === "yankee") {
        return await reject(LiveBidMessages.AUCTION_TYPE_UNSUPPORTED_BID);
      }
      // Re-read wall-clock AFTER the FOR UPDATE lock is held. `now()` is frozen
      // at transaction start, so a bid that waited in the lock queue would otherwise
      // be accepted after the lot ended (or miss an anti-snipe window).
      const clock = await tx.execute<{
        time_to_start_sec: number;
        time_left_sec: number;
        effective_end: string | null;
      }>(sql`
        SELECT
          EXTRACT(EPOCH FROM (((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - clock_timestamp()))::int AS time_to_start_sec,
          EXTRACT(EPOCH FROM ((COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata')) - clock_timestamp()))::int AS time_left_sec,
          to_char(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)), 'YYYY-MM-DD"T"HH24:MI:SS') AS effective_end
        FROM auction_lots l
        JOIN auctions a ON a.auction_id = l.auction_id
        WHERE l.id = ${input.lotId}
      `);
      const clockRow = clock.rows[0];
      if (!clockRow) return await reject(LiveBidMessages.LOT_NOT_FOUND);
      lot.time_to_start_sec = clockRow.time_to_start_sec;
      lot.time_left_sec = clockRow.time_left_sec;
      lot.effective_end = clockRow.effective_end;

      // A lot is only open between its start and end time (start/end from the
      // lot, date from the auction). Reject bids before it opens or after close.
      if (lot.time_to_start_sec > 0) {
        return await reject(LiveBidMessages.BIDDING_NOT_STARTED);
      }
      if (lot.time_left_sec <= 0)
        return await reject(LiveBidMessages.BIDDING_TIME_OVER);

      // Registered participant (auction-wide or this lot), T&C accepted, IP
      // restriction.
      const gateErr = await bidderGateError(tx, {
        auctionId: input.auctionId,
        lotId: input.lotId,
        bidderId: input.bidderId,
        tncBlocked: lot.tnc_blocked,
        ipRestrictionEnabled: lot.ip_restriction_enabled,
        ip,
      });
      if (gateErr) return await reject(gateErr);

      if (lot.is_rank_based === true) {
        return this.placeRankBasedBid(tx, lot, input, ip, reject);
      }

      const startPrice = Number(lot.start_bid_price ?? 0);
      const increment = Number(lot.bid_increment ?? 0);
      const bidLimit = lot.bid_limit != null ? Number(lot.bid_limit) : null;
      const hasBids = lot.winning_amount != null;
      const currentWinning = hasBids ? Number(lot.winning_amount) : startPrice;
      const amount = input.amount;
      const direction = bidDirectionFor(lot.auction_type);
      const boundsLot: BidBoundsLot = {
        bidCount: hasBids ? 1 : 0,
        currentBid: currentWinning,
        bidIncrement: increment,
        startBidPrice: startPrice,
        sbpPlusIncrement: lot.sbp_plus_increment_enabled === true,
        bidLimit,
        auctionType: lot.auction_type,
      };

      const amountErr = manualBidAmountError(boundsLot, amount, direction);
      if (amountErr) return await reject(amountErr);

      const ownProxyErr = await this.checkAndRetireOwnProxy(
        tx,
        input,
        direction,
      );
      if (ownProxyErr) return await reject(ownProxyErr);

      // The manual bid always clears the next-bid bound, so it leads unless a
      // proxy answers. Earlier always wins: a proxy set before this bid that
      // covers its amount holds the lot at this amount, and this bid is
      // recorded after it as the losing tie.
      const affected = new Set<number>([input.bidderId]);
      if (lot.winner_bidder_id != null) affected.add(lot.winner_bidder_id);
      const settled = await this.settleLotProxies(
        tx,
        {
          auctionId: input.auctionId,
          lotId: input.lotId,
          startPrice,
          increment,
          sbpPlusIncrement: lot.sbp_plus_increment_enabled === true,
          direction,
        },
        { bidderId: input.bidderId, userId: input.userId, amount, ip },
      );
      for (const id of settled) affected.add(id);

      // ---- Anti-sniping auto-extend + lot staggering (per-client config) ----
      const extendResult = await this.maybeExtend(tx, lot, input);

      // Re-read after settlement so the HTTP response carries the true winning amount /
      // standing (a rival proxy may have auto-outbid this manual bid).
      const final = await tx.execute<{
        winner_bidder_id: number | null;
        winning_amount: string | null;
        live_rev: number;
      }>(sql`
        SELECT winner_bidder_id, winning_amount, live_rev
        FROM auction_lots WHERE id = ${input.lotId}
      `);
      const row = final.rows[0];
      if (!row) return await reject(LiveBidMessages.LOT_NOT_FOUND);
      if (row.winner_bidder_id != null) affected.add(row.winner_bidder_id);
      // One log row for the bidder's manual attempt (accepted into the engine).
      await insertBidLog(tx, {
        auctionId: input.auctionId,
        lotId: input.lotId,
        bidderId: input.bidderId,
        userId: input.userId,
        amount,
        isProxy: false,
        proxyAmount: null,
        ip,
        isAccepted: true,
        rejectReason: null,
      });
      return {
        accepted: true,
        amount,
        finalAmount:
          row.winning_amount != null ? Number(row.winning_amount) : amount,
        yourStatus: standingAfterSettle(row.winner_bidder_id, input.bidderId),
        rev: row.live_rev ?? 0,
        extended: extendResult.extended,
        affectedBidderIds: [...affected],
        yourRank: null,
        yourBid: null,
      };
    });
  }

  /**
   * A manual bid that does not beat your own standing proxy is pointless, so it
   * is rejected. Otherwise the proxy is retired before settlement so it takes no
   * part in the auto-bid war. Returns the rejection reason, or null.
   */
  private async checkAndRetireOwnProxy(
    tx: Tx,
    input: { lotId: number; bidderId: number; amount: number },
    direction: BidDirection,
  ): Promise<string | null> {
    const ownProxy = await tx.execute<{ max_amount: string }>(sql`
      SELECT max_amount FROM auction_proxy_bids
      WHERE lot_id = ${input.lotId} AND bidder_id = ${input.bidderId} AND is_active = true
      LIMIT 1
    `);
    const ownMax = ownProxy.rows[0] ? Number(ownProxy.rows[0].max_amount) : 0;
    if (ownMax <= 0) return null;
    if (
      direction === 1
        ? paise(input.amount) <= paise(ownMax)
        : paise(input.amount) >= paise(ownMax)
    ) {
      return direction === 1
        ? LiveBidMessages.BELOW_OWN_PROXY
        : LiveBidMessages.ABOVE_OWN_PROXY;
    }
    await tx.execute(sql`
      UPDATE auction_proxy_bids SET is_active = false, updated_at = now()
      WHERE lot_id = ${input.lotId} AND bidder_id = ${input.bidderId} AND is_active = true
    `);
    return null;
  }

  /** The bidder's own best ledger bid on the lot (max forward / min reverse). */
  private async loadOwnBest(
    tx: Tx,
    lotId: number,
    bidderId: number,
    direction: BidDirection,
  ): Promise<number | null> {
    const own = await tx.execute<{ best: string | null }>(sql`
      SELECT ${direction === 1 ? sql`MAX(amount)` : sql`MIN(amount)`} AS best
      FROM auction_bids
      WHERE lot_id = ${lotId} AND bidder_id = ${bidderId}
    `);
    return own.rows[0]?.best != null ? Number(own.rows[0].best) : null;
  }

  /**
   * Rank-based bid: bounded by the bidder's own best bid (never the withheld
   * winning price). Equal amounts are allowed; the first to reach an amount
   * keeps it. The bid only takes the lead when it strictly beats the standing
   * winning amount — then proxies settle as in a normal auction (an earlier
   * proxy at the same limit wins); otherwise it just moves the bidder up the
   * ranking. Runs inside placeBid's transaction with the lot row already locked.
   */
  private async placeRankBasedBid(
    tx: Tx,
    lot: {
      start_bid_price: string | null;
      bid_increment: string | null;
      bid_limit: string | null;
      winning_amount: string | null;
      winner_bidder_id: number | null;
      auction_type: string | null;
      sbp_plus_increment_enabled: boolean | null;
    } & Parameters<LiveBidService["maybeExtend"]>[1],
    input: {
      auctionId: number;
      lotId: number;
      bidderId: number;
      userId: number;
      amount: number;
    },
    ip: string | null,
    reject: (reason: string) => Promise<BidResult>,
  ): Promise<BidResult> {
    const amount = input.amount;
    const direction = bidDirectionFor(lot.auction_type);
    const ownBest = await this.loadOwnBest(
      tx,
      input.lotId,
      input.bidderId,
      direction,
    );

    const amountErr = rankBidAmountError(
      rankBoundsLot(
        {
          bidIncrement: Number(lot.bid_increment ?? 0),
          startBidPrice: Number(lot.start_bid_price ?? 0),
          sbpPlusIncrement: lot.sbp_plus_increment_enabled === true,
          bidLimit: lot.bid_limit != null ? Number(lot.bid_limit) : null,
          auctionType: lot.auction_type,
        },
        ownBest,
      ),
      amount,
      direction,
    );
    if (amountErr) return reject(amountErr);

    const ownProxyErr = await this.checkAndRetireOwnProxy(tx, input, direction);
    if (ownProxyErr) return reject(ownProxyErr);

    // Strict: an equal amount never displaces whoever reached it first.
    const takesLead =
      lot.winning_amount == null ||
      (direction === 1
        ? paise(amount) > paise(Number(lot.winning_amount))
        : paise(amount) < paise(Number(lot.winning_amount)));
    const affected = new Set<number>([input.bidderId]);
    if (lot.winner_bidder_id != null) affected.add(lot.winner_bidder_id);
    if (takesLead) {
      // A rival proxy may answer the new lead; settlement records this bid in
      // commitment order alongside any proxy rows.
      const settled = await this.settleLotProxies(
        tx,
        {
          auctionId: input.auctionId,
          lotId: input.lotId,
          startPrice: Number(lot.start_bid_price ?? 0),
          increment: Number(lot.bid_increment ?? 0),
          sbpPlusIncrement: lot.sbp_plus_increment_enabled === true,
          direction,
        },
        { bidderId: input.bidderId, userId: input.userId, amount, ip },
      );
      for (const id of settled) affected.add(id);
    } else {
      // A bid that doesn't lead needs no settlement: the leader is unchanged
      // and every other proxy is exhausted. It just takes its rank.
      await tx.insert(auctionBids).values({
        auctionId: input.auctionId,
        lotId: input.lotId,
        bidderId: input.bidderId,
        userId: input.userId,
        amount: amount.toFixed(2),
        ip,
        createdAt: sql`clock_timestamp()`,
      });
      await bumpLotBidStats(tx, input.lotId, input.bidderId);
    }

    const extendResult = await this.maybeExtend(tx, lot, input);

    const final = await tx.execute<{
      winner_bidder_id: number | null;
      live_rev: number;
    }>(sql`
      SELECT winner_bidder_id, live_rev FROM auction_lots WHERE id = ${input.lotId}
    `);
    const row = final.rows[0];
    if (!row) return reject(LiveBidMessages.LOT_NOT_FOUND);
    if (row.winner_bidder_id != null) affected.add(row.winner_bidder_id);

    await insertBidLog(tx, {
      auctionId: input.auctionId,
      lotId: input.lotId,
      bidderId: input.bidderId,
      userId: input.userId,
      amount,
      isProxy: false,
      proxyAmount: null,
      ip,
      isAccepted: true,
      rejectReason: null,
    });

    const [mine] = await loadRankings(
      tx,
      sql`lot_id = ${input.lotId}`,
      direction,
      input.bidderId,
    );
    return {
      accepted: true,
      amount,
      finalAmount: null,
      yourStatus: standingAfterSettle(row.winner_bidder_id, input.bidderId),
      rev: row.live_rev ?? 0,
      extended: extendResult.extended,
      affectedBidderIds: [...affected],
      yourRank: mine?.rank ?? null,
      yourBid: mine?.best ?? amount,
    };
  }

  /**
   * Set (or raise) the current bidder's proxy max for a lot, then let the
   * auto-bid engine settle the lot. Mirrors legacy usp_InsertProxyBid: the max
   * can only be raised, must be a whole increment, at least the start price, and
   * within the lot's max bid limit.
   */
  async setProxyBid(input: {
    auctionId: number;
    lotId: number;
    bidderId: number;
    userId: number;
    maxAmount: number;
    ip?: string | null;
  }): Promise<ProxyResult> {
    const ip = normalizeClientIp(input.ip);
    return db.transaction(async (tx) => {
      let canLog = false;
      const reject = async (reason: string): Promise<ProxyResult> => {
        if (canLog) {
          await insertBidLog(tx, {
            auctionId: input.auctionId,
            lotId: input.lotId,
            bidderId: input.bidderId,
            userId: input.userId,
            amount: input.maxAmount,
            isProxy: true,
            proxyAmount: null,
            ip,
            isAccepted: false,
            rejectReason: reason,
          });
        }
        return { accepted: false, reason };
      };

      // Same lot gate as placeBid (locked FOR UPDATE), plus the bidder's own
      // current proxy max so we can enforce raise-only.
      const lotRes = await tx.execute<{
        id: number;
        auction_id: number;
        is_active: boolean;
        start_bid_price: string | null;
        bid_increment: string | null;
        bid_limit: string | null;
        winning_amount: string | null;
        sbp_plus_increment_enabled: boolean | null;
        auction_type: string | null;
        time_to_start_sec: number;
        time_left_sec: number;
        effective_end: string | null;
        display_order: string | null;
        last_bid_extension_count: number;
        is_last_bid_extension: boolean | null;
        last_bid_extension_window: number | null;
        last_bid_extension_interval: number | null;
        last_bid_extension_count_max: number | null;
        is_staggered: boolean | null;
        stagger_interval: number | null;
        tnc_blocked: boolean;
        ip_restriction_enabled: boolean | null;
        own_max: string | null;
        is_rank_based: boolean | null;
        is_reopened: boolean;
      }>(sql`
        SELECT l.id, l.auction_id, l.is_active,
               l.start_bid_price, l.bid_increment, l.bid_limit,
               l.winning_amount,
               a.is_start_bid_price_plus_increment AS sbp_plus_increment_enabled,
               a.auction_type,
               a.ip_address_restriction_enabled AS ip_restriction_enabled,
               a.is_rank_based, l.is_reopened,
               l.display_order, l.last_bid_extension_count,
               to_char(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)), 'YYYY-MM-DD"T"HH24:MI:SS') AS effective_end,
               EXTRACT(EPOCH FROM (((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now()))::int AS time_to_start_sec,
               EXTRACT(EPOCH FROM ((COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata')) - now()))::int AS time_left_sec,
               c.is_last_bid_extension, c.last_bid_extension_window, c.last_bid_extension_interval, c.last_bid_extension_count_max,
               COALESCE(a.is_staggered, c.is_staggered) AS is_staggered,
               c.stagger_interval,
               (EXISTS (SELECT 1 FROM auction_documents d
                  WHERE d.auction_id = a.auction_id AND d.document_type_id = 2 AND d.is_active)
                AND NOT EXISTS (SELECT 1 FROM auction_tnc_acceptances t
                  WHERE t.auction_id = a.auction_id AND t.bidder_id = ${input.bidderId})) AS tnc_blocked,
               (SELECT p.max_amount FROM auction_proxy_bids p
                  WHERE p.lot_id = l.id AND p.bidder_id = ${input.bidderId} AND p.is_active = true
                  LIMIT 1) AS own_max
        FROM auction_lots l
        JOIN auctions a ON a.auction_id = l.auction_id
        JOIN clients c ON c.id = a.client_id
        WHERE l.id = ${input.lotId}
        FOR UPDATE OF l
      `);
      const lot = lotRes.rows[0];
      if (!lot) return reject(LiveBidMessages.LOT_NOT_FOUND);
      canLog = true;
      if (!lot.is_active) return await reject(LiveBidMessages.LOT_NOT_FOUND);
      if (lot.auction_id !== input.auctionId)
        return await reject(LiveBidMessages.LOT_AUCTION_MISMATCH);
      if (lot.auction_type === "yankee") {
        return await reject(LiveBidMessages.AUCTION_TYPE_UNSUPPORTED_PROXY);
      }

      // Re-read wall-clock AFTER the FOR UPDATE lock (same rationale as placeBid).
      const clock = await tx.execute<{
        time_to_start_sec: number;
        time_left_sec: number;
        effective_end: string | null;
      }>(sql`
        SELECT
          EXTRACT(EPOCH FROM (((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - clock_timestamp()))::int AS time_to_start_sec,
          EXTRACT(EPOCH FROM ((COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata')) - clock_timestamp()))::int AS time_left_sec,
          to_char(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)), 'YYYY-MM-DD"T"HH24:MI:SS') AS effective_end
        FROM auction_lots l
        JOIN auctions a ON a.auction_id = l.auction_id
        WHERE l.id = ${input.lotId}
      `);
      const clockRow = clock.rows[0];
      if (!clockRow) return await reject(LiveBidMessages.LOT_NOT_FOUND);
      lot.time_to_start_sec = clockRow.time_to_start_sec;
      lot.time_left_sec = clockRow.time_left_sec;
      lot.effective_end = clockRow.effective_end;

      if (lot.time_to_start_sec > 0) {
        return await reject(LiveBidMessages.BIDDING_NOT_STARTED);
      }
      if (lot.time_left_sec <= 0)
        return await reject(LiveBidMessages.BIDDING_TIME_OVER);

      const gateErr = await bidderGateError(tx, {
        auctionId: input.auctionId,
        lotId: input.lotId,
        bidderId: input.bidderId,
        tncBlocked: lot.tnc_blocked,
        ipRestrictionEnabled: lot.ip_restriction_enabled,
        ip,
      });
      if (gateErr) return await reject(gateErr);

      const startPrice = Number(lot.start_bid_price ?? 0);
      const increment = Number(lot.bid_increment ?? 0);
      const bidLimit =
        lot.bid_limit != null ? Number(lot.bid_limit) : null;
      const ownMax = lot.own_max != null ? Number(lot.own_max) : 0;
      const maxAmount = input.maxAmount;
      const hasBids = lot.winning_amount != null;
      const currentWinning = hasBids ? Number(lot.winning_amount) : startPrice;
      const direction = bidDirectionFor(lot.auction_type);
      const rankBased = lot.is_rank_based === true;

      if (!(increment > 0))
        return await reject(LiveBidMessages.NO_INCREMENT);
      if (!(maxAmount > 0))
        return await reject(LiveBidMessages.BID_GREATER_THAN_ZERO);
      const sbpPlusIncrement = lot.sbp_plus_increment_enabled === true;
      if (rankBased) {
        // Same own-best bound as a rank-based manual bid. Never compared with
        // the withheld winning amount, so a rejection can't reveal it; a limit
        // that can't lead just bids its max and takes its rank.
        const ownBest = await this.loadOwnBest(
          tx,
          input.lotId,
          input.bidderId,
          direction,
        );
        const amountErr = rankBidAmountError(
          rankBoundsLot(
            {
              bidIncrement: increment,
              startBidPrice: startPrice,
              sbpPlusIncrement,
              bidLimit,
              auctionType: lot.auction_type,
            },
            ownBest,
          ),
          maxAmount,
          direction,
        );
        if (amountErr) return await reject(amountErr);
      } else {
        // Same next-bid bound as placeBid / minBidFor / minProxyMaxFor.
        const boundsLot: BidBoundsLot = {
          bidCount: hasBids ? 1 : 0,
          currentBid: currentWinning,
          bidIncrement: increment,
          startBidPrice: startPrice,
          sbpPlusIncrement,
          bidLimit,
          auctionType: lot.auction_type,
        };
        // Proxy limit must at least match standing (equal allowed for first-come
        // proxy tie); must clear next-bid bound; must stay within bid_limit / 50×.
        if (
          hasBids &&
          (direction === 1
            ? paise(maxAmount) < paise(currentWinning)
            : paise(maxAmount) > paise(currentWinning))
        ) {
          return await reject(outbidRejection(lot.auction_type, direction));
        }
        const amountErr = manualBidAmountError(boundsLot, maxAmount, direction);
        if (amountErr) return await reject(amountErr);
      }
      // Raise-only (forward) / lower-only (reverse).
      if (
        ownMax > 0 &&
        (direction === 1
          ? paise(maxAmount) <= paise(ownMax)
          : paise(maxAmount) >= paise(ownMax))
      ) {
        return await reject(
          direction === 1
            ? LiveBidMessages.PROXY_RAISE_ONLY
            : LiveBidMessages.PROXY_LOWER_ONLY,
        );
      }

      // Retire the previous active limit, record the new one. created_at is the
      // proxy's commitment time — the tie-break key — so take wall-clock time
      // after the lot lock (`now()` is frozen at transaction start).
      if (ownMax > 0) {
        await tx.execute(sql`
          UPDATE auction_proxy_bids SET is_active = false, updated_at = now()
          WHERE lot_id = ${input.lotId} AND bidder_id = ${input.bidderId} AND is_active = true
        `);
      }
      await tx.execute(sql`
        INSERT INTO auction_proxy_bids
          (auction_id, lot_id, bidder_id, user_id, max_amount, is_active, created_at)
        VALUES (${input.auctionId}, ${input.lotId}, ${input.bidderId}, ${input.userId},
                ${maxAmount.toFixed(2)}, true, clock_timestamp())
      `);

      // Settle the lot with the new limit in play.
      const settled = await this.settleLotProxies(
        tx,
        {
          auctionId: input.auctionId,
          lotId: input.lotId,
          startPrice,
          increment,
          sbpPlusIncrement,
          direction,
        },
      );
      const affected = new Set<number>([input.bidderId, ...settled]);

      // Setting/raising a proxy is a bid event too — it can extend the lot.
      const extendResult = await this.maybeExtend(tx, lot, {
        auctionId: input.auctionId,
        lotId: input.lotId,
        bidderId: input.bidderId,
        userId: input.userId,
      });

      // Same post-settlement standing as placeBid — a lower proxy max loses
      // immediately to a higher standing rival, and the client needs that now.
      const final = await tx.execute<{
        winner_bidder_id: number | null;
        winning_amount: string | null;
        live_rev: number;
      }>(sql`
        SELECT winner_bidder_id, winning_amount, live_rev
        FROM auction_lots WHERE id = ${input.lotId}
      `);
      const row = final.rows[0];
      if (!row) return await reject(LiveBidMessages.LOT_NOT_FOUND);
      if (row.winner_bidder_id != null) affected.add(row.winner_bidder_id);
      await insertBidLog(tx, {
        auctionId: input.auctionId,
        lotId: input.lotId,
        bidderId: input.bidderId,
        userId: input.userId,
        amount: maxAmount,
        isProxy: true,
        proxyAmount: null,
        ip,
        isAccepted: true,
        rejectReason: null,
      });
      const [mine] = rankBased
        ? await loadRankings(
            tx,
            sql`lot_id = ${input.lotId}`,
            direction,
            input.bidderId,
          )
        : [];
      return {
        accepted: true,
        maxAmount,
        finalAmount: rankBased
          ? null
          : row.winning_amount != null
            ? Number(row.winning_amount)
            : maxAmount,
        yourStatus: standingAfterSettle(row.winner_bidder_id, input.bidderId),
        rev: row.live_rev ?? 0,
        extended: extendResult.extended,
        affectedBidderIds: [...affected],
        yourRank: mine?.rank ?? null,
        yourBid: mine?.best ?? null,
      };
    });
  }

  /**
   * Run the auto-bid war on a lot and denormalize the resulting winner onto
   * auction_lots. Reads the current winner and all active proxies, asks the pure
   * settleProxies() who should win and at what price, then writes the bids
   * into auction_bids (for history / admin visibility).
   *
   * Earlier always wins: proxies are keyed by when they were set, a manual
   * leader by when it reached the winning amount, and a `pending` manual bid
   * (the one being placed, which leads unless a proxy answers) is the latest.
   * Every losing proxy is exhausted and recorded at its limit. Rows are written
   * in the order they were committed — price progression first, then
   * commitment time — so the ledger reads as the auction actually ran.
   */
  private async settleLotProxies(
    tx: Tx,
    ctx: {
      auctionId: number;
      lotId: number;
      startPrice: number;
      increment: number;
      sbpPlusIncrement: boolean;
      direction: BidDirection;
    },
    pending?: { bidderId: number; userId: number; amount: number; ip: string | null },
  ): Promise<AffectedBidderIds> {
    // Bidders this settlement moved — returned so the caller can tell the
    // broadcast exactly whose standing to re-push.
    const affected = new Set<number>();
    if (pending) affected.add(pending.bidderId);
    // The leader's commitment time at the winning amount: their earliest row
    // there (an auto-bid carries its proxy's set time).
    const cur = await tx.execute<{
      winner_bidder_id: number | null;
      winning_amount: string | null;
      leader_committed_us: string | null;
    }>(sql`
      SELECT l.winner_bidder_id, l.winning_amount,
             (SELECT (EXTRACT(EPOCH FROM MIN(COALESCE(b.committed_at, b.created_at))) * 1000000)::bigint::text
                FROM auction_bids b
               WHERE b.lot_id = l.id AND b.bidder_id = l.winner_bidder_id
                 AND b.amount = l.winning_amount) AS leader_committed_us
      FROM auction_lots l WHERE l.id = ${ctx.lotId}
    `);
    const winnerBidderId = cur.rows[0]?.winner_bidder_id ?? null;
    if (winnerBidderId != null) affected.add(winnerBidderId);
    const winningAmount =
      cur.rows[0]?.winning_amount != null
        ? Number(cur.rows[0].winning_amount)
        : null;
    const leaderOrder =
      cur.rows[0]?.leader_committed_us != null
        ? Number(cur.rows[0].leader_committed_us)
        : Number.MAX_SAFE_INTEGER;

    const proxyRows = await tx.execute<{
      id: number;
      bidder_id: number;
      user_id: number;
      max_amount: string;
      committed_us: string;
    }>(sql`
      SELECT id, bidder_id, user_id, max_amount,
             (EXTRACT(EPOCH FROM created_at) * 1000000)::bigint::text AS committed_us
      FROM auction_proxy_bids
      WHERE lot_id = ${ctx.lotId} AND is_active = true
      ORDER BY created_at ASC, id ASC
    `);
    const proxies = proxyRows.rows.map((r) => ({
      id: r.id,
      bidderId: r.bidder_id,
      userId: r.user_id,
      max: Number(r.max_amount),
      order: Number(r.committed_us),
    }));

    const contenders: Contender[] = proxies.map((p) => ({
      bidderId: p.bidderId,
      max: p.max,
      order: p.order,
      isProxy: true,
    }));

    if (pending) {
      // The bid being placed beats the standing amount, so it replaces any
      // manual leader as the bound to beat — and it is the latest commitment.
      contenders.push({
        bidderId: pending.bidderId,
        max: pending.amount,
        order: Number.MAX_SAFE_INTEGER,
        isProxy: false,
      });
    } else if (winnerBidderId != null && winningAmount != null) {
      const wc = contenders.find((c) => c.bidderId === winnerBidderId);
      if (!wc) {
        // Current winner without a proxy = a standing manual leader; include
        // them as a fixed contender, keyed by when they reached the amount.
        contenders.push({
          bidderId: winnerBidderId,
          max: winningAmount,
          order: leaderOrder,
          isProxy: false,
        });
      } else if (
        ctx.direction === 1 ? winningAmount > wc.max : winningAmount < wc.max
      ) {
        // Sitting beyond their own proxy limit via a better manual bid: their
        // standing is that amount, committed when they reached it.
        wc.max = winningAmount;
        wc.order = leaderOrder;
      }
    }

    const settlement = settleProxies(
      contenders,
      ctx.startPrice,
      ctx.increment,
      ctx.sbpPlusIncrement,
      ctx.direction,
    );

    type Row = {
      bidderId: number;
      userId: number;
      amount: number;
      order: number;
      proxy: (typeof proxies)[number] | null;
    };
    const rows: Row[] = [];
    if (pending) {
      rows.push({
        bidderId: pending.bidderId,
        userId: pending.userId,
        amount: pending.amount,
        order: Number.MAX_SAFE_INTEGER,
        proxy: null,
      });
    }

    let lotWinner: { bidderId: number; userId: number; amount: number } | null =
      pending && (!settlement || !settlement.winnerIsProxy)
        ? { bidderId: pending.bidderId, userId: pending.userId, amount: pending.amount }
        : null;

    if (settlement) {
      // Every other proxy is exhausted: record it at its limit unless the
      // bidder already has a row there or beyond.
      for (const p of proxies) {
        if (p.bidderId === settlement.winnerBidderId) continue;
        const already = await tx.execute(sql`
          SELECT 1 FROM auction_bids
          WHERE lot_id = ${ctx.lotId} AND bidder_id = ${p.bidderId}
            AND ${
              ctx.direction === 1
                ? sql`amount >= ${p.max.toFixed(2)}`
                : sql`amount <= ${p.max.toFixed(2)}`
            }
          LIMIT 1
        `);
        if (already.rows.length === 0) {
          rows.push({ bidderId: p.bidderId, userId: p.userId, amount: p.max, order: p.order, proxy: p });
          affected.add(p.bidderId);
        }
      }

      // A proxy takes (or improves) the lead.
      if (settlement.winnerIsProxy) {
        const winner = proxies.find(
          (p) => p.bidderId === settlement.winnerBidderId,
        )!;
        const amountImproved =
          winningAmount == null ||
          (ctx.direction === 1
            ? paise(settlement.amount) > paise(winningAmount)
            : paise(settlement.amount) < paise(winningAmount));
        if (winnerBidderId !== winner.bidderId || amountImproved) {
          rows.push({
            bidderId: winner.bidderId,
            userId: winner.userId,
            amount: settlement.amount,
            order: winner.order,
            proxy: winner,
          });
          lotWinner = {
            bidderId: winner.bidderId,
            userId: winner.userId,
            amount: settlement.amount,
          };
          affected.add(winner.bidderId);
        }
      }
    }

    // Commitment order: the price as it progressed (up for forward, down for
    // reverse), then whoever committed to that price first.
    rows.sort((a, b) =>
      a.amount !== b.amount
        ? ctx.direction === 1
          ? a.amount - b.amount
          : b.amount - a.amount
        : a.order - b.order,
    );
    for (const r of rows) {
      if (r.proxy) {
        await this.insertAutoBid(tx, ctx, r.proxy, r.amount);
      } else {
        await tx.insert(auctionBids).values({
          auctionId: ctx.auctionId,
          lotId: ctx.lotId,
          bidderId: r.bidderId,
          userId: r.userId,
          amount: r.amount.toFixed(2),
          ip: pending?.ip ?? null,
          createdAt: sql`clock_timestamp()`,
        });
        await bumpLotBidStats(tx, ctx.lotId, r.bidderId);
      }
    }

    if (lotWinner) {
      await tx
        .update(auctionLots)
        .set({
          winningAmount: lotWinner.amount.toFixed(2),
          winnerBidderId: lotWinner.bidderId,
          winnerUserId: lotWinner.userId,
          liveRev: sql`live_rev + 1`,
          updatedAt: sql`now()`,
          updatedBy: lotWinner.userId,
        })
        .where(eq(auctionLots.id, ctx.lotId));
    }
    return [...affected];
  }

  /** Writes a proxy's auto-bid, committed at the proxy's set time. */
  private async insertAutoBid(
    tx: Tx,
    ctx: { auctionId: number; lotId: number },
    proxy: { id: number; bidderId: number; userId: number; max: number },
    amount: number,
  ): Promise<void> {
    await tx.insert(auctionBids).values({
      auctionId: ctx.auctionId,
      lotId: ctx.lotId,
      bidderId: proxy.bidderId,
      userId: proxy.userId,
      amount: amount.toFixed(2),
      isProxy: true,
      proxyAmount: proxy.max.toFixed(2),
      // The bidder committed to this amount when the proxy was set; created_at
      // stays the wall-clock write time for the history.
      committedAt: sql`(SELECT created_at FROM auction_proxy_bids WHERE id = ${proxy.id})`,
      createdAt: sql`clock_timestamp()`,
    });
    await insertBidLog(tx, {
      auctionId: ctx.auctionId,
      lotId: ctx.lotId,
      bidderId: proxy.bidderId,
      userId: proxy.userId,
      amount,
      isProxy: true,
      proxyAmount: proxy.max,
      ip: null,
      isAccepted: true,
      rejectReason: null,
    });
    await bumpLotBidStats(tx, ctx.lotId, proxy.bidderId);
  }

  /** The current bidder's active proxy max per lot, for the auction. */
  async myProxies(
    auctionId: number,
    bidderId: number,
  ): Promise<Record<number, number>> {
    const res = await db.execute<{ lot_id: number; max_amount: string }>(sql`
      SELECT lot_id, max_amount FROM auction_proxy_bids
      WHERE auction_id = ${auctionId} AND bidder_id = ${bidderId} AND is_active = true
    `);
    const out: Record<number, number> = {};
    for (const r of res.rows) out[r.lot_id] = Number(r.max_amount);
    return out;
  }

  // Extends only this lot when a bid lands inside the client's sniping
  // window; stagger (if enabled) adds stagger interval onto later lots'
  // current ends — extension intervals never cascade.
  private async maybeExtend(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    lot: {
      auction_id: number;
      display_order: string | null;
      last_bid_extension_count: number;
      effective_end: string | null;
      time_left_sec: number;
      is_reopened: boolean;
      is_last_bid_extension: boolean | null;
      last_bid_extension_window: number | null;
      last_bid_extension_interval: number | null;
      last_bid_extension_count_max: number | null;
      is_staggered: boolean | null;
      stagger_interval: number | null;
    },
    input: {
      auctionId: number;
      lotId: number;
      bidderId: number;
      userId: number;
    },
  ): Promise<ExtendResult> {
    const none: ExtendResult = { extended: false };
    const inWindow = shouldLastBidExtension({
      isLastBidExtension: lot.is_last_bid_extension,
      lastBidExtensionWindow: lot.last_bid_extension_window,
      lastBidExtensionInterval: lot.last_bid_extension_interval,
      lastBidExtensionCountMax: lot.last_bid_extension_count_max,
      lastBidExtensionCount: lot.last_bid_extension_count,
      timeLeftSec: lot.time_left_sec,
      hasEffectiveEnd: lot.effective_end != null,
      isReopened: lot.is_reopened,
    });
    if (!inWindow) return none;

    const extendBy = lot.last_bid_extension_interval!;

    // Extend only this lot. Stagger cascade (if any) chains subsequent lots
    // from this lot's post-extension end.
    const oldEndRes = await tx.execute<{ old_end_ms: string }>(sql`
      SELECT (EXTRACT(EPOCH FROM ${lot.effective_end}::timestamptz) * 1000)::bigint::text AS old_end_ms
    `);
    const oldEndMs = Number(oldEndRes.rows[0]?.old_end_ms ?? 0);
    await tx.execute(sql`
      UPDATE auction_lots
      SET extended_end_time = ${lot.effective_end}::timestamptz + make_interval(secs => ${extendBy}),
          last_bid_extension_count = last_bid_extension_count + 1,
          live_rev = live_rev + 1,
          updated_at = now(), updated_by = ${input.userId}
      WHERE id = ${input.lotId}
    `);

    await tx.execute(sql`
      INSERT INTO auction_lot_extensions
        (auction_id, lot_id, old_ends_at, new_ends_at, extended_by_sec, triggered_by_bidder_id, reason)
      VALUES (${input.auctionId}, ${input.lotId}, ${lot.effective_end}::timestamptz,
              ${lot.effective_end}::timestamptz + make_interval(secs => ${extendBy}),
              ${extendBy}, ${input.bidderId}, 'last_bid'::lot_extension_reason)
    `);

    // Chain subsequent lots from this lot's post-extension end.
    const enabled = lot.is_staggered === true;
    const stagBy = lot.stagger_interval ?? 0;
    const newEndMs = oldEndMs + extendBy * 1000;
    if (shouldStagger(enabled, stagBy) && newEndMs > 0) {
      await applyCascadeFromAnchor(tx, {
        auctionId: input.auctionId,
        anchorLotId: input.lotId,
        anchorEndMs: newEndMs,
        enabled,
        intervalSec: stagBy,
      });
    }

    return { extended: true };
  }

  // ---- Watch list -----------------------------------------------------------

  /** The bidder's active proxy maxes across all auctions ({ lotId: maxAmount }). */
  async myProxiesAll(bidderId: number): Promise<Record<number, number>> {
    const res = await db.execute<{ lot_id: number; max_amount: string }>(sql`
      SELECT lot_id, max_amount FROM auction_proxy_bids
      WHERE bidder_id = ${bidderId} AND is_active = true
    `);
    const out: Record<number, number> = {};
    for (const r of res.rows) out[r.lot_id] = Number(r.max_amount);
    return out;
  }

  /** Lot ids the bidder has bid on or holds an active proxy for (for "participated"). */
  async myParticipation(bidderId: number): Promise<number[]> {
    const res = await db.execute<{ lot_id: number }>(sql`
      SELECT DISTINCT lot_id FROM (
        SELECT lot_id FROM auction_bids WHERE bidder_id = ${bidderId}
        UNION
        SELECT lot_id FROM auction_proxy_bids
        WHERE bidder_id = ${bidderId} AND is_active = true
      ) t
    `);
    return res.rows.map((r) => r.lot_id);
  }

  /** Lot ids the bidder is watching on still-published auctions. */
  async watchlist(bidderId: number): Promise<number[]> {
    const res = await db.execute<{ lot_id: number }>(sql`
      SELECT w.lot_id
      FROM auction_lot_watchlist w
      INNER JOIN auction_lots l ON l.id = w.lot_id AND l.is_active
      INNER JOIN auctions a ON a.auction_id = l.auction_id
      WHERE w.bidder_id = ${bidderId}
        AND a.status = 'published'
        AND a.published_at <= now()
        AND a.is_active
    `);
    return res.rows.map((r) => r.lot_id);
  }

  /** Add a lot to the bidder's watch list (idempotent). */
  async addToWatchlist(bidderId: number, lotId: number): Promise<void> {
    await db.execute(sql`
      INSERT INTO auction_lot_watchlist (bidder_id, lot_id)
      VALUES (${bidderId}, ${lotId})
      ON CONFLICT (bidder_id, lot_id) DO NOTHING
    `);
  }

  /** Remove a lot from the bidder's watch list. */
  async removeFromWatchlist(bidderId: number, lotId: number): Promise<void> {
    await db.execute(sql`
      DELETE FROM auction_lot_watchlist
      WHERE bidder_id = ${bidderId} AND lot_id = ${lotId}
    `);
  }
}

export const liveBidService = new LiveBidService();

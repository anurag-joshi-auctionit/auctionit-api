import { sql } from "drizzle-orm";
import { LiveBidMessages } from "@auctionit/messages/auctions";
import {
  bidDirectionFor,
  sealedBidAmountError,
} from "@auctionit/lib/live-bid-bounds";
import { db } from "../db/index.js";
import { auctionSealedBids } from "../db/schema/auction-sealed-bids.js";
import { normalizeClientIp } from "../lib/auctions/ip-restriction.js";
import { bidderGateError, tncBlockedSql } from "../lib/auctions/bidder-gate.js";
import type { AuctionVisibility } from "../live/visibility.js";

/** Sealed-bid window as IST instants, for SQL. Expects the auction aliased `a`. */
const WINDOW_START = sql`((a.sealed_bid_date::date + a.sealed_bid_start_time) AT TIME ZONE 'Asia/Kolkata')`;
const WINDOW_END = sql`((a.sealed_bid_date::date + a.sealed_bid_end_time) AT TIME ZONE 'Asia/Kolkata')`;
const ISO_UTC = (expr: ReturnType<typeof sql>) =>
  sql`to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type SealedBidResult =
  | { accepted: true; yourBid: number; placedAt: string }
  | { accepted: false; reason: string };

export type SealedWindowAuction = {
  id: number;
  auctionNumber: string | null;
  clientId: number | null;
  clientName: string | null;
  auctionType: string | null;
  windowStartsAt: string;
  windowEndsAt: string;
  secondsLeft: number;
  lotCount: number;
  /** Bidder view only: active T&C the bidder hasn't accepted. */
  tncRequired: boolean;
};

/**
 * Sealed-bid window bidding. Bidders see only their own latest bid — never the
 * start price, bid limit, leading price or rank; a rejected bid names the bound
 * it crossed. The live snapshot and lot details withhold the same bounds from
 * bidders during the sealed phase (see sealedPhaseSql). Bids are append-only in
 * auction_sealed_bids; a bidder's latest row is their bid and must strictly
 * beat their previous one. Ties on amount go to the earliest bid at close.
 */
export class SealedBidService {
  async placeSealedBid(input: {
    auctionId: number;
    lotId: number;
    bidderId: number;
    userId: number;
    amount: number;
    ip?: string | null;
  }): Promise<SealedBidResult> {
    const ip = normalizeClientIp(input.ip);
    return db.transaction(async (tx) => {
      const reject = (reason: string): SealedBidResult => ({
        accepted: false,
        reason,
      });

      // Lock the lot row so one bidder's concurrent bids on the lot serialize
      // against their own latest bid (same pattern as LiveBidService.placeBid).
      const lotRes = await tx.execute<{
        id: number;
        auction_id: number;
        client_id: number;
        is_active: boolean;
        status: string;
        auction_type: string | null;
        is_sealed_bid: boolean;
        has_window: boolean;
        start_bid_price: string | null;
        bid_limit: string | null;
        ip_restriction_enabled: boolean | null;
        tnc_blocked: boolean;
      }>(sql`
        SELECT l.id, l.auction_id, a.client_id, l.is_active, a.status,
               a.auction_type, a.is_sealed_bid,
               (a.sealed_bid_date IS NOT NULL
                 AND a.sealed_bid_start_time IS NOT NULL
                 AND a.sealed_bid_end_time IS NOT NULL) AS has_window,
               l.start_bid_price, l.bid_limit,
               a.ip_address_restriction_enabled AS ip_restriction_enabled,
               ${tncBlockedSql(input.bidderId)} AS tnc_blocked
        FROM auction_lots l
        JOIN auctions a ON a.auction_id = l.auction_id
        WHERE l.id = ${input.lotId}
        FOR UPDATE OF l
      `);
      const lot = lotRes.rows[0];
      if (!lot || !lot.is_active) return reject(LiveBidMessages.LOT_NOT_FOUND);
      if (lot.auction_id !== input.auctionId) {
        return reject(LiveBidMessages.LOT_AUCTION_MISMATCH);
      }
      if (!lot.is_sealed_bid || !lot.has_window) {
        return reject(LiveBidMessages.SEALED_BID_NOT_ENABLED);
      }
      if (lot.auction_type === "yankee") {
        return reject(LiveBidMessages.AUCTION_TYPE_UNSUPPORTED_BID);
      }

      // Wall clock after the lock — now() is frozen at transaction start.
      const clock = await tx.execute<{ started: boolean; ended: boolean }>(sql`
        SELECT ${WINDOW_START} <= clock_timestamp() AS started,
               ${WINDOW_END} <= clock_timestamp() AS ended
        FROM auctions a WHERE a.auction_id = ${input.auctionId}
      `);
      const c = clock.rows[0];
      if (lot.status !== "published" || !c?.started) {
        return reject(
          c?.ended
            ? LiveBidMessages.SEALED_WINDOW_CLOSED
            : LiveBidMessages.SEALED_WINDOW_NOT_OPEN,
        );
      }
      if (c.ended) return reject(LiveBidMessages.SEALED_WINDOW_CLOSED);

      const gateErr = await bidderGateError(tx, {
        auctionId: input.auctionId,
        lotId: input.lotId,
        bidderId: input.bidderId,
        tncBlocked: lot.tnc_blocked,
        ipRestrictionEnabled: lot.ip_restriction_enabled,
        ip,
      });
      if (gateErr) return reject(gateErr);

      const own = await tx.execute<{ amount: string }>(sql`
        SELECT amount FROM auction_sealed_bids
        WHERE lot_id = ${input.lotId} AND bidder_id = ${input.bidderId}
          AND NOT is_removed
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `);
      const ownLatest = own.rows[0] ? Number(own.rows[0].amount) : null;

      const amountErr = sealedBidAmountError(
        {
          startBidPrice:
            lot.start_bid_price != null ? Number(lot.start_bid_price) : null,
          bidLimit: lot.bid_limit != null ? Number(lot.bid_limit) : null,
          ownLatest,
        },
        input.amount,
        bidDirectionFor(lot.auction_type),
      );
      if (amountErr) return reject(amountErr);

      const [row] = await tx
        .insert(auctionSealedBids)
        .values({
          auctionId: input.auctionId,
          lotId: input.lotId,
          clientId: lot.client_id,
          bidderId: input.bidderId,
          userId: input.userId,
          amount: input.amount.toFixed(2),
          ip,
        })
        .returning({ createdAt: auctionSealedBids.createdAt });
      return {
        accepted: true,
        yourBid: Number(input.amount.toFixed(2)),
        placedAt: row!.createdAt,
      };
    });
  }

  /**
   * Published auctions whose sealed-bid window is open now. Bidders see only
   * auctions they are mapped to; client users only their clients' auctions.
   */
  async listOpen(opts: {
    bidderId?: number | null;
    clientUserId?: number | null;
  }): Promise<SealedWindowAuction[]> {
    const bidderId = opts.clientUserId != null ? null : opts.bidderId ?? null;
    const bidderFilter =
      bidderId != null
        ? sql`AND EXISTS (
            SELECT 1 FROM auction_lot_bidder_maps m
            WHERE m.auction_id = a.auction_id AND m.bidder_id = ${bidderId}
              AND m.is_active = true
          )`
        : sql``;
    const clientFilter =
      opts.clientUserId != null
        ? sql`AND a.client_id IN (
            SELECT uc.client_id FROM user_clients uc
            WHERE uc.user_id = ${opts.clientUserId} AND uc.is_active = true
          )`
        : sql``;
    const res = await db.execute<{
      id: number;
      auction_number: string | null;
      client_id: number | null;
      client_name: string | null;
      auction_type: string | null;
      window_starts_at: string;
      window_ends_at: string;
      seconds_left: number;
      lot_count: number;
      tnc_required: boolean;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number, a.client_id,
             c.company_name AS client_name, a.auction_type,
             ${ISO_UTC(WINDOW_START)} AS window_starts_at,
             ${ISO_UTC(WINDOW_END)} AS window_ends_at,
             EXTRACT(EPOCH FROM (${WINDOW_END} - now()))::int AS seconds_left,
             (SELECT count(*) FROM auction_lots l
                WHERE l.auction_id = a.auction_id AND l.is_active)::int AS lot_count,
             ${bidderId != null ? tncBlockedSql(bidderId) : sql`false`} AS tnc_required
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.status = 'published' AND a.is_active AND a.is_sealed_bid
        AND a.sealed_bid_date IS NOT NULL
        AND a.sealed_bid_start_time IS NOT NULL
        AND a.sealed_bid_end_time IS NOT NULL
        AND ${WINDOW_START} <= now() AND ${WINDOW_END} > now()
        ${bidderFilter}
        ${clientFilter}
      ORDER BY ${WINDOW_END} ASC
      LIMIT 100
    `);
    return res.rows.map((r) => ({
      id: r.id,
      auctionNumber: r.auction_number,
      clientId: r.client_id,
      clientName: r.client_name,
      auctionType: r.auction_type,
      windowStartsAt: r.window_starts_at,
      windowEndsAt: r.window_ends_at,
      secondsLeft: r.seconds_left,
      lotCount: r.lot_count,
      tncRequired: r.tnc_required === true,
    }));
  }

  /**
   * Bidder's sealed-bid page: window + their visible lots with only their own
   * latest bid. Start price, bid limit and anyone else's bids are deliberately
   * not returned — a rejected bid names the bound it crossed.
   */
  async myView(
    auctionId: number,
    bidderId: number,
    visibility: AuctionVisibility,
  ) {
    const auctionRes = await db.execute<{
      id: number;
      auction_number: string | null;
      client_name: string | null;
      auction_type: string | null;
      status: string;
      is_sealed_bid: boolean;
      window_starts_at: string | null;
      window_ends_at: string | null;
      server_time: string;
      tnc_required: boolean;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number, c.company_name AS client_name,
             a.auction_type, a.status, a.is_sealed_bid,
             ${ISO_UTC(WINDOW_START)} AS window_starts_at,
             ${ISO_UTC(WINDOW_END)} AS window_ends_at,
             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS server_time,
             ${tncBlockedSql(bidderId)} AS tnc_required
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.auction_id = ${auctionId}
    `);
    const a = auctionRes.rows[0];
    if (!a || !a.is_sealed_bid) return null;

    const lotFilter =
      visibility.lotIds == null
        ? sql``
        : visibility.lotIds.size === 0
          ? sql`AND false`
          : sql`AND l.id IN (${sql.join(
              [...visibility.lotIds].map((id) => sql`${id}`),
              sql`, `,
            )})`;
    const lotsRes = await db.execute<{
      id: number;
      lot_number: string | null;
      title: string | null;
      quantity: string | null;
      uom: string | null;
      material_location: string | null;
      your_bid: string | null;
      your_bid_at: string | null;
      your_bid_count: number;
    }>(sql`
      SELECT l.id, l.lot_number, l.quantity, u.code AS uom,
             ml.name AS material_location,
             (SELECT COALESCE(NULLIF(it.name, ''), NULLIF(ali.material_name, ''), ali.material_description)
                FROM auction_lot_items ali
                LEFT JOIN items it ON it.id = ali.item_id
                WHERE ali.lot_id = l.id AND ali.is_active
                ORDER BY ali.id LIMIT 1) AS title,
             own.amount AS your_bid,
             to_char(own.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS your_bid_at,
             (SELECT count(*) FROM auction_sealed_bids sb
                WHERE sb.lot_id = l.id AND sb.bidder_id = ${bidderId}
                  AND NOT sb.is_removed)::int AS your_bid_count
      FROM auction_lots l
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN material_locations ml ON ml.id = l.material_location_id
      LEFT JOIN LATERAL (
        SELECT sb.amount, sb.created_at FROM auction_sealed_bids sb
        WHERE sb.lot_id = l.id AND sb.bidder_id = ${bidderId} AND NOT sb.is_removed
        ORDER BY sb.created_at DESC, sb.id DESC
        LIMIT 1
      ) own ON true
      WHERE l.auction_id = ${auctionId} AND l.is_active ${lotFilter}
      ORDER BY l.display_order NULLS LAST, l.id
    `);

    return {
      auctionId: a.id,
      auctionNumber: a.auction_number,
      clientName: a.client_name,
      auctionType: a.auction_type,
      status: a.status,
      windowStartsAt: a.window_starts_at,
      windowEndsAt: a.window_ends_at,
      serverTime: a.server_time,
      tncRequired: a.tnc_required === true,
      lots: lotsRes.rows.map((r) => ({
        lotId: r.id,
        lotNumber: r.lot_number,
        title: r.title,
        quantity: r.quantity != null ? Number(r.quantity) : null,
        uom: r.uom,
        materialLocation: r.material_location,
        yourBid: r.your_bid != null ? Number(r.your_bid) : null,
        yourBidAt: r.your_bid_at,
        yourBidCount: r.your_bid_count,
      })),
    };
  }

  /**
   * Admin / client per-lot summary: bid and bidder counts plus the current
   * leader (best latest bid per bidder, earliest wins a tie).
   */
  async summary(auctionId: number) {
    const res = await db.execute<{
      lot_id: number;
      lot_number: string | null;
      start_bid_price: string | null;
      quantity: string | null;
      uom: string | null;
      window_starts_at: string | null;
      window_ends_at: string | null;
      bid_count: number;
      bidder_count: number;
      leader_bidder_id: number | null;
      leader_bidder_name: string | null;
      leader_amount: string | null;
      leader_at: string | null;
    }>(sql`
      WITH latest AS (
        SELECT DISTINCT ON (sb.lot_id, sb.bidder_id)
          sb.id, sb.lot_id, sb.bidder_id, sb.amount, sb.created_at
        FROM auction_sealed_bids sb
        WHERE sb.auction_id = ${auctionId} AND NOT sb.is_removed
        ORDER BY sb.lot_id, sb.bidder_id, sb.created_at DESC, sb.id DESC
      ),
      ranked AS (
        SELECT lt.*, ROW_NUMBER() OVER (
          PARTITION BY lt.lot_id
          ORDER BY
            CASE WHEN a.auction_type = 'reverse' THEN -lt.amount ELSE lt.amount END DESC,
            lt.created_at ASC, lt.id ASC
        ) AS rn
        FROM latest lt
        JOIN auctions a ON a.auction_id = ${auctionId}
      )
      SELECT l.id AS lot_id, l.lot_number, l.start_bid_price, l.quantity,
             u.code AS uom,
             ${ISO_UTC(WINDOW_START)} AS window_starts_at,
             ${ISO_UTC(WINDOW_END)} AS window_ends_at,
             (SELECT count(*) FROM auction_sealed_bids sb WHERE sb.lot_id = l.id AND NOT sb.is_removed)::int AS bid_count,
             (SELECT count(DISTINCT sb.bidder_id) FROM auction_sealed_bids sb WHERE sb.lot_id = l.id AND NOT sb.is_removed)::int AS bidder_count,
             r.bidder_id AS leader_bidder_id, b.company_name AS leader_bidder_name,
             r.amount AS leader_amount,
             to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS leader_at
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN ranked r ON r.lot_id = l.id AND r.rn = 1
      LEFT JOIN bidders b ON b.id = r.bidder_id
      WHERE l.auction_id = ${auctionId} AND l.is_active
      ORDER BY l.display_order NULLS LAST, l.id
    `);
    return res.rows.map((r) => ({
      lotId: r.lot_id,
      lotNumber: r.lot_number,
      startBidPrice: r.start_bid_price != null ? Number(r.start_bid_price) : null,
      quantity: r.quantity != null ? Number(r.quantity) : null,
      uom: r.uom,
      windowStartsAt: r.window_starts_at,
      windowEndsAt: r.window_ends_at,
      bidCount: r.bid_count,
      bidderCount: r.bidder_count,
      leaderBidderId: r.leader_bidder_id,
      leaderBidderName: r.leader_bidder_name,
      leaderAmount: r.leader_amount != null ? Number(r.leader_amount) : null,
      leaderAt: r.leader_at,
    }));
  }

  /**
   * Every sealed-bid on a lot, newest first, flagging each bidder's latest
   * (their counted bid) and the current leader among those.
   */
  async lotBids(lotId: number) {
    const res = await db.execute<{
      id: number;
      bidder_id: number;
      bidder_name: string | null;
      amount: string;
      ip: string | null;
      placed_at: string;
      is_latest: boolean;
      is_leader: boolean;
    }>(sql`
      WITH bids AS (
        SELECT sb.*,
               ROW_NUMBER() OVER (
                 PARTITION BY sb.bidder_id ORDER BY sb.created_at DESC, sb.id DESC
               ) = 1 AS is_latest
        FROM auction_sealed_bids sb
        WHERE sb.lot_id = ${lotId} AND NOT sb.is_removed
      ),
      leader AS (
        SELECT bd.id FROM bids bd
        JOIN auctions a ON a.auction_id = bd.auction_id
        WHERE bd.is_latest
        ORDER BY
          CASE WHEN a.auction_type = 'reverse' THEN -bd.amount ELSE bd.amount END DESC,
          bd.created_at ASC, bd.id ASC
        LIMIT 1
      )
      SELECT bd.id, bd.bidder_id, b.company_name AS bidder_name, bd.amount, bd.ip,
             to_char(bd.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS placed_at,
             bd.is_latest,
             bd.id = (SELECT id FROM leader) AS is_leader
      FROM bids bd
      LEFT JOIN bidders b ON b.id = bd.bidder_id
      ORDER BY bd.created_at DESC, bd.id DESC
    `);
    return res.rows.map((r) => ({
      id: r.id,
      bidderId: r.bidder_id,
      bidderName: r.bidder_name,
      amount: Number(r.amount),
      ip: r.ip,
      placedAt: r.placed_at,
      isLatest: r.is_latest === true,
      isLeader: r.is_leader === true,
    }));
  }
}

export const sealedBidService = new SealedBidService();

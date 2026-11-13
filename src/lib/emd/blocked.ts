import { sql, type SQL } from "drizzle-orm";
import {
  EMD_BLOCK_RELEASE_TYPES,
  EMD_BLOCK_TYPES_IN,
  sqlInList,
} from "./constants.js";

const BLOCK_IN = sql.raw(sqlInList(EMD_BLOCK_TYPES_IN));
const BLOCK_OUT = sql.raw(sqlInList(EMD_BLOCK_RELEASE_TYPES));

function bidderFilter(column: SQL, bidderIds: number[] | null): SQL {
  if (bidderIds == null) return sql`true`;
  if (bidderIds.length === 0) return sql`false`;
  return sql`${column} = ANY(${`{${bidderIds.join(",")}}`}::int[])`;
}

/**
 * Blocked balance per (bidder, auction): blocks minus releases minus approved
 * forfeitures. One bucket: money blocked for a lot stays here while the bidder
 * is winning it, until it is released or forfeited. Values are not clamped
 * here; callers apply GREATEST(.., 0) where a display total is needed (a few
 * legacy ledgers release more than they blocked).
 */
export function blockedByAuctionSql(bidderIds: number[] | null): SQL {
  return sql`
    SELECT x.bidder_id, x.auction_id, SUM(x.amt) AS blocked
    FROM (
      SELECT t.bidder_id, t.auction_id,
        CASE WHEN t.emd_type IN (${BLOCK_IN}) THEN t.amount ELSE -t.amount END AS amt
      FROM emd_transactions t
      WHERE t.auction_id IS NOT NULL
        AND t.emd_type IN (${BLOCK_IN}, ${BLOCK_OUT})
        AND ${bidderFilter(sql`t.bidder_id`, bidderIds)}
      UNION ALL
      SELECT f.bidder_id, f.auction_id, -f.amount
      FROM emd_forfeitures f
      WHERE f.status = 'forfeited'
        AND ${bidderFilter(sql`f.bidder_id`, bidderIds)}
    ) x
    GROUP BY x.bidder_id, x.auction_id`;
}

/** Blocked balance per bidder on one auction (uses the auction/bidder index). */
export function blockedOnAuctionSql(auctionId: number, bidderIds: number[] | null): SQL {
  return sql`
    SELECT x.bidder_id, SUM(x.amt) AS blocked
    FROM (
      SELECT t.bidder_id,
        CASE WHEN t.emd_type IN (${BLOCK_IN}) THEN t.amount ELSE -t.amount END AS amt
      FROM emd_transactions t
      WHERE t.auction_id = ${auctionId}
        AND t.emd_type IN (${BLOCK_IN}, ${BLOCK_OUT})
        AND ${bidderFilter(sql`t.bidder_id`, bidderIds)}
      UNION ALL
      SELECT f.bidder_id, -f.amount
      FROM emd_forfeitures f
      WHERE f.auction_id = ${auctionId} AND f.status = 'forfeited'
        AND ${bidderFilter(sql`f.bidder_id`, bidderIds)}
    ) x
    GROUP BY x.bidder_id`;
}

/**
 * What is still held for the ranges a bidder won, per (bidder, auction, range):
 * `amount_held` minus what was released or forfeited. Rows still above zero.
 */
export function holdsByRangeSql(bidderIds: number[] | null): SQL {
  return sql`
    SELECT h.bidder_id, h.auction_id, h.emd_range_id,
      (h.amount_held - h.amount_released - h.amount_forfeited) AS held
    FROM emd_range_holds h
    WHERE h.amount_held - h.amount_released - h.amount_forfeited > 0
      AND ${bidderFilter(sql`h.bidder_id`, bidderIds)}`;
}

/**
 * The part of a bidder's Blocked balance on one auction that is not held for
 * a won range: the block a live auction's attach, detach and re-block work on.
 */
export function liveBlockOnAuctionSql(auctionId: number, bidderIds: number[] | null): SQL {
  return sql`
    SELECT b.bidder_id,
      GREATEST(GREATEST(b.blocked, 0) - COALESCE(h.held, 0), 0) AS blocked
    FROM (${blockedOnAuctionSql(auctionId, bidderIds)}) b
    LEFT JOIN (
      SELECT q.bidder_id, SUM(q.held) AS held
      FROM (${holdsByRangeSql(bidderIds)}) q
      WHERE q.auction_id = ${auctionId}
      GROUP BY q.bidder_id
    ) h ON h.bidder_id = b.bidder_id`;
}

/** `liveBlockOnAuctionSql` for every auction, per (bidder, auction). */
export function liveBlockByAuctionSql(bidderIds: number[] | null): SQL {
  return sql`
    SELECT b.bidder_id, b.auction_id,
      GREATEST(GREATEST(b.blocked, 0) - COALESCE(h.held, 0), 0) AS blocked
    FROM (${blockedByAuctionSql(bidderIds)}) b
    LEFT JOIN (
      SELECT q.bidder_id, q.auction_id, SUM(q.held) AS held
      FROM (${holdsByRangeSql(bidderIds)}) q
      GROUP BY q.bidder_id, q.auction_id
    ) h ON h.bidder_id = b.bidder_id AND h.auction_id = b.auction_id`;
}

export function availableByBidderSql(bidderIds: number[] | null): SQL {
  return sql`
    SELECT t.bidder_id,
      SUM(CASE WHEN t.txn_type = 'credit' THEN t.amount ELSE -t.amount END) AS available
    FROM emd_transactions t
    WHERE ${bidderFilter(sql`t.bidder_id`, bidderIds)}
    GROUP BY t.bidder_id`;
}

/**
 * Recomputes the `bidders` balance caches from the ledger. `null` rebuilds
 * every bidder (seed / reconcile). `emd_winning_balance` is no longer written:
 * held money is part of `emd_blocked_balance`.
 */
export function refreshBalanceCachesSql(bidderIds: number[] | null): SQL {
  return sql`
    UPDATE bidders b
    SET emd_available_balance = COALESCE(a.available, 0),
        emd_blocked_balance = COALESCE(bk.blocked, 0)
    FROM bidders src
    LEFT JOIN (${availableByBidderSql(bidderIds)}) a ON a.bidder_id = src.id
    LEFT JOIN (
      SELECT bidder_id, SUM(GREATEST(blocked, 0)) AS blocked
      FROM (${blockedByAuctionSql(bidderIds)}) q GROUP BY bidder_id
    ) bk ON bk.bidder_id = src.id
    WHERE b.id = src.id AND ${bidderFilter(sql`src.id`, bidderIds)}`;
}

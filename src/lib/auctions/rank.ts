import { sql, type SQL } from "drizzle-orm";
import type { BidDirection } from "@auctionit/lib/live-bid-bounds";
import type { db } from "../../db/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SqlExecutor = Pick<Tx, "execute">;

export type RankedBid = { lotId: number; bidderId: number; rank: number; best: number };

/**
 * Each bidder's best bid per lot (highest for forward, lowest for reverse),
 * ranked best first. Equal amounts are allowed, and the first to commit to an
 * amount ranks higher — earlier always wins. An auto-bid commits at its
 * proxy's set time (`committed_at`), a manual bid when written.
 */
export async function loadRankings(
  executor: SqlExecutor,
  lotFilter: SQL,
  direction: BidDirection,
  bidderId?: number,
): Promise<RankedBid[]> {
  const order = direction === 1 ? sql`DESC` : sql`ASC`;
  const bidderFilter = bidderId != null ? sql`WHERE bidder_id = ${bidderId}` : sql``;
  const res = await executor.execute<{
    lot_id: number;
    bidder_id: number;
    best: string;
    your_rank: number;
  }>(sql`
    SELECT lot_id, bidder_id, best, your_rank FROM (
      SELECT b.lot_id, b.bidder_id, b.best,
             ROW_NUMBER() OVER (
               PARTITION BY b.lot_id
               ORDER BY b.best ${order}, b.best_at ASC, b.best_id ASC
             )::int AS your_rank
      FROM (
        SELECT DISTINCT ON (lot_id, bidder_id)
               lot_id, bidder_id, amount AS best,
               COALESCE(committed_at, created_at) AS best_at, id AS best_id
        FROM auction_bids
        WHERE ${lotFilter}
        ORDER BY lot_id, bidder_id, amount ${order},
                 COALESCE(committed_at, created_at) ASC, id ASC
      ) b
    ) r
    ${bidderFilter}
  `);
  return res.rows.map((r) => ({
    lotId: r.lot_id,
    bidderId: r.bidder_id,
    rank: Number(r.your_rank),
    best: Number(r.best),
  }));
}

/**
 * Attach each bidder's lot rank (null when unranked) and order rank-first.
 * Stable: unranked rows and equal ranks keep their incoming order.
 */
export function withBidderRanks<T extends { bidderId: number }>(
  rows: T[],
  rankings: RankedBid[],
): (T & { rank: number | null })[] {
  const byBidder = new Map(rankings.map((r) => [r.bidderId, r.rank]));
  return rows
    .map((row) => ({ ...row, rank: byBidder.get(row.bidderId) ?? null }))
    .sort((a, b) => {
      if (a.rank == null) return b.rank == null ? 0 : 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank;
    });
}

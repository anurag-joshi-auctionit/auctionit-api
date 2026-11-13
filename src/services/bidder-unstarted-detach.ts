import { sql } from "drizzle-orm";
import { BiddersInfoMessages } from "@auctionit/messages/bidders";
import { formatUtcNow } from "@auctionit/lib/date";
import { db } from "../db/index.js";
import { auctionLotBidderMaps } from "../db/schema/index.js";
import { liveBlockByAuctionSql } from "../lib/emd/blocked.js";
import { emdBlocksService } from "./emd-blocks.service.js";
import { emdTransactionsService } from "./emd-transactions.service.js";

export type DetachUnstartedResult = {
  removedMapCount: number;
  releasedEmdAuctionCount: number;
};

/** Lot start is still ahead (or unset). Matches the live-bid IST clock. */
const lotNotStartedSql = sql`(
  l.start_time IS NULL
  OR EXTRACT(EPOCH FROM (
    ((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata')
    - clock_timestamp()
  )) > 0
)`;

const lotStartedSql = sql`(
  l.start_time IS NOT NULL
  AND EXTRACT(EPOCH FROM (
    ((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata')
    - clock_timestamp()
  )) <= 0
)`;

/**
 * Soft-detach this bidder from lots that have not started, and release EMD on
 * auctions they can no longer participate in and never bid on.
 *
 * Closed auctions are left alone. An auction-wide map (lot_id IS NULL) is
 * replaced with per-lot maps for lots that have already started, so a later
 * lot cannot pick them up, while live lots stay biddable.
 */
export async function detachBidderFromUnstartedLots(
  bidderId: number,
  userId: number,
): Promise<DetachUnstartedResult> {
  const now = formatUtcNow();

  const lotIdsByAuction = new Map<number, number[]>();

  const removedMapCount = await db.transaction(async (tx) => {
    const detachedLots = await tx.execute<{ lot_id: number; auction_id: number }>(sql`
      UPDATE auction_lot_bidder_maps AS m
      SET is_active = false, updated_at = ${now}, updated_by = ${userId}
      FROM auction_lots AS l
      INNER JOIN auctions AS a ON a.auction_id = l.auction_id
      WHERE m.lot_id = l.id
        AND m.bidder_id = ${bidderId}
        AND m.is_active = true
        AND a.status <> 'closed'
        AND ${lotNotStartedSql}
      RETURNING m.lot_id, l.auction_id
    `);
    for (const row of detachedLots.rows) {
      const lotIds = lotIdsByAuction.get(row.auction_id) ?? [];
      lotIds.push(row.lot_id);
      lotIdsByAuction.set(row.auction_id, lotIds);
    }

    const poolRows = await tx.execute<{
      auction_id: number;
      client_id: number;
      is_emd_with_client: boolean | null;
    }>(sql`
      SELECT DISTINCT ON (m.auction_id)
        m.auction_id, m.client_id, m.is_emd_with_client
      FROM auction_lot_bidder_maps m
      INNER JOIN auctions a ON a.auction_id = m.auction_id
      WHERE m.bidder_id = ${bidderId}
        AND m.is_active = true
        AND m.lot_id IS NULL
        AND a.status <> 'closed'
      ORDER BY m.auction_id, m.id
    `);

    let upcomingPoolCount = 0;
    if (poolRows.rows.length > 0) {
      const auctionIds = poolRows.rows.map((r) => r.auction_id);
      const upcomingPools = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
        FROM auctions a
        WHERE a.auction_id IN (${sql.join(
          auctionIds.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND (
            NOT EXISTS (
              SELECT 1 FROM auction_lots l
              WHERE l.auction_id = a.auction_id AND l.is_active = true
            )
            OR EXISTS (
              SELECT 1 FROM auction_lots l
              WHERE l.auction_id = a.auction_id
                AND l.is_active = true
                AND ${lotNotStartedSql}
            )
          )
      `);
      upcomingPoolCount = Number(upcomingPools.rows[0]?.n ?? 0);
      const startedLots = await tx.execute<{
        auction_id: number;
        lot_id: number;
      }>(sql`
        SELECT l.auction_id, l.id AS lot_id
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        WHERE l.auction_id IN (${sql.join(
          auctionIds.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND l.is_active = true
          AND ${lotStartedSql}
          AND NOT EXISTS (
            SELECT 1 FROM auction_lot_bidder_maps existing
            WHERE existing.auction_id = l.auction_id
              AND existing.lot_id = l.id
              AND existing.bidder_id = ${bidderId}
              AND existing.is_active = true
          )
      `);

      if (startedLots.rows.length > 0) {
        const maxId = await tx.execute<{ n: number }>(sql`
          SELECT COALESCE(MAX(id), 0)::int AS n FROM auction_lot_bidder_maps
        `);
        let nextId = Number(maxId.rows[0]?.n ?? 0) + 1;
        const poolByAuction = new Map(
          poolRows.rows.map((r) => [r.auction_id, r] as const),
        );
        const replacements = startedLots.rows.flatMap((lot) => {
          const pool = poolByAuction.get(lot.auction_id);
          if (!pool) return [];
          return [
            {
              id: nextId++,
              auctionId: lot.auction_id,
              clientId: pool.client_id,
              bidderId,
              lotId: lot.lot_id,
              isEmdWithClient: pool.is_emd_with_client ?? false,
              isActive: true,
              createdAt: now,
              createdBy: userId,
            },
          ];
        });
        if (replacements.length > 0) {
          await tx.insert(auctionLotBidderMaps).values(replacements);
        }
      }

      await tx.execute(sql`
        UPDATE auction_lot_bidder_maps AS m
        SET is_active = false, updated_at = ${now}, updated_by = ${userId}
        FROM auctions AS a
        WHERE a.auction_id = m.auction_id
          AND m.bidder_id = ${bidderId}
          AND m.is_active = true
          AND m.lot_id IS NULL
          AND a.status <> 'closed'
      `);
    }

    await tx.execute(sql`
      UPDATE auction_proxy_bids AS p
      SET is_active = false, updated_at = ${now}
      FROM auction_lots AS l
      INNER JOIN auctions AS a ON a.auction_id = l.auction_id
      WHERE p.lot_id = l.id
        AND p.bidder_id = ${bidderId}
        AND p.is_active = true
        AND a.status <> 'closed'
        AND ${lotNotStartedSql}
    `);

    return detachedLots.rows.length + upcomingPoolCount;
  });

  const releasedEmdAuctionCount = await releaseUnparticipatedEmd(
    bidderId,
    userId,
    lotIdsByAuction,
  );

  return { removedMapCount, releasedEmdAuctionCount };
}

async function releaseUnparticipatedEmd(
  bidderId: number,
  userId: number,
  lotIdsByAuction: Map<number, number[]>,
): Promise<number> {
  const rows = await db.execute<{ auction_id: number }>(sql`
    SELECT q.auction_id FROM (${liveBlockByAuctionSql([bidderId])}) q
    WHERE q.blocked > 0
      AND EXISTS (
        SELECT 1 FROM auctions a
        WHERE a.auction_id = q.auction_id AND a.status <> 'closed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM auction_lot_bidder_maps m
        WHERE m.auction_id = q.auction_id
          AND m.bidder_id = ${bidderId}
          AND m.is_active = true
      )
      AND NOT EXISTS (
        SELECT 1 FROM auction_bids b
        WHERE b.auction_id = q.auction_id AND b.bidder_id = ${bidderId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM auction_proxy_bids p
        WHERE p.auction_id = q.auction_id
          AND p.bidder_id = ${bidderId}
          AND p.is_active = true
      )
  `);

  let released = 0;
  for (const row of rows.rows) {
    const amount = await emdTransactionsService.run((tx) =>
      emdBlocksService.releaseFullBlock(tx, {
        auctionId: row.auction_id,
        bidderId,
        emdType: "release_bidder_unverified",
        remarks: BiddersInfoMessages.VERIFICATION_REMOVED_EMD_NOTE,
        lotIds: lotIdsByAuction.get(row.auction_id) ?? null,
        userId,
      }),
    );
    if (amount > 0) released += 1;
  }
  return released;
}

import pg from "pg";
import { env } from "../../env.js";
import { updateBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";

/**
 * Backfill denormalized bid stats + no-bid extension stop state onto auction_lots.
 *
 * Sources (MSSQL):
 * - bid_count / bidder_count / bidder_ids:
 *     tbl_Data_AuctionTransaction
 *     UNION ALL tbl_Data_YankeeTransaction
 *   (sealed-bid window bids live in auction_sealed_bids — not live bid stats)
 * - is_no_bid_extension (set false) / no_bid_extension_stopped_at:
 *     tbl_Data_AuctionLotForCloseAutoTimeIncrement
 *
 * Bidder IDs are aggregated in Node (not STRING_AGG) to avoid MSSQL's
 * 8000-byte VARCHAR aggregation limit on lots with many distinct bidders.
 */

const BID_ROWS_SQL = `
SELECT LotId AS lotId, BidderCompId AS bidderCompId
FROM (
  SELECT LotId, BidderCompId
  FROM tbl_Data_AuctionTransaction
  WHERE LotId IS NOT NULL AND BidderCompId IS NOT NULL

  UNION ALL

  SELECT LotId, BidderCompId
  FROM tbl_Data_YankeeTransaction
  WHERE LotId IS NOT NULL AND BidderCompId IS NOT NULL
    AND (IsActive IS NULL OR IsActive = 1)
) t
`;

const STOPPED_SQL = `
SELECT
  AuctionId AS auctionId,
  LotId AS lotId,
  CONVERT(varchar(33), CreatedDateTime, 126) AS stoppedAt
FROM tbl_Data_AuctionLotForCloseAutoTimeIncrement
ORDER BY LotId
`;

const UPDATE_BID_STATS_SQL = `
UPDATE auction_lots l
SET
  bid_count = v.bid_count,
  bidder_count = v.bidder_count,
  bidder_ids = v.bidder_ids
FROM json_to_recordset($1::json)
  AS v(id int, bid_count int, bidder_count int, bidder_ids int[])
WHERE l.id = v.id
`;

const UPDATE_STOPPED_SQL = `
UPDATE auction_lots l
SET
  is_no_bid_extension = false,
  no_bid_extension_stopped_at = v.stopped_at
FROM json_to_recordset($1::json)
  AS v(id int, auction_id int, stopped_at timestamptz)
WHERE l.id = v.id AND l.auction_id = v.auction_id
`;

type LotBidStats = {
  bidCount: number;
  bidderIds: Set<number>;
};

function intOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function aggregateBidStats(
  rows: Array<{ lotId: unknown; bidderCompId: unknown }>,
): Map<number, LotBidStats> {
  const byLot = new Map<number, LotBidStats>();
  for (const r of rows) {
    const lotId = intOrNull(r.lotId);
    const bidderCompId = intOrNull(r.bidderCompId);
    if (lotId == null || bidderCompId == null) continue;
    let stats = byLot.get(lotId);
    if (!stats) {
      stats = { bidCount: 0, bidderIds: new Set() };
      byLot.set(lotId, stats);
    }
    stats.bidCount += 1;
    stats.bidderIds.add(bidderCompId);
  }
  return byLot;
}

function filterBidderIds(
  bidderIds: Set<number>,
  validBidderIds: Set<number>,
): number[] {
  return [...bidderIds]
    .filter((id) => validBidderIds.has(id))
    .sort((a, b) => a - b);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const [bidRowsResult, stoppedResult] = await Promise.all([
      mssqlPool.request().query(BID_ROWS_SQL),
      mssqlPool.request().query(STOPPED_SQL),
    ]);
    const bidStatsByLot = aggregateBidStats(bidRowsResult.recordset);
    console.log(
      `Pulled ${bidRowsResult.recordset.length} bid rows across ${bidStatsByLot.size} lots and ${stoppedResult.recordset.length} stopped-no-bid-extension rows from MSSQL.`,
    );

    const [lotIds, bidderIds] = await Promise.all([
      pgPool.query<{ id: number; auction_id: number }>(
        "SELECT id, auction_id FROM auction_lots",
      ),
      pgPool.query<{ id: number }>("SELECT id FROM bidders"),
    ]);
    const validLotIds = new Set(lotIds.rows.map((r) => r.id));
    const lotAuctionIds = new Map(
      lotIds.rows.map((r) => [r.id, r.auction_id] as const),
    );
    const validBidderIds = new Set(bidderIds.rows.map((r) => r.id));

    const matchedLotIds = [...bidStatsByLot.keys()].filter((id) =>
      validLotIds.has(id),
    );
    const matchedStopped = stoppedResult.recordset.filter(
      (r: { lotId: number; auctionId: number }) =>
        validLotIds.has(Number(r.lotId)) &&
        lotAuctionIds.get(Number(r.lotId)) === Number(r.auctionId),
    );

    if (dryRun) {
      console.log("Dry run — no rows updated.");
      console.log(
        `Would update bid stats on ${matchedLotIds.length} lots; mark ${matchedStopped.length} lots as no-bid extension stopped.`,
      );
      console.table(
        matchedLotIds.slice(0, 5).map((lotId) => {
          const stats = bidStatsByLot.get(lotId)!;
          const filtered = filterBidderIds(stats.bidderIds, validBidderIds);
          return {
            lotId,
            bidCount: stats.bidCount,
            bidderCount: filtered.length,
            bidderIdsSample: filtered.slice(0, 5).join(","),
          };
        }),
      );
      return;
    }

    const client = await pgPool.connect();
    let bidStatsUpdated = 0;
    let bidStatsSkipped = 0;
    let stoppedUpdated = 0;
    let stoppedSkipped = 0;

    try {
      await client.query("BEGIN");

      const bidStatsRows: object[] = [];
      for (const [lotId, stats] of bidStatsByLot) {
        if (!validLotIds.has(lotId)) {
          bidStatsSkipped++;
          continue;
        }
        const bidderIdsFiltered = filterBidderIds(
          stats.bidderIds,
          validBidderIds,
        );

        bidStatsRows.push({
          id: lotId,
          bid_count: stats.bidCount,
          bidder_count: bidderIdsFiltered.length,
          bidder_ids: bidderIdsFiltered,
        });
        bidStatsUpdated++;
      }
      await updateBatched(client, "bid stats", UPDATE_BID_STATS_SQL, bidStatsRows);

      const stoppedRows: object[] = [];
      for (const r of stoppedResult.recordset) {
        const lotId = intOrNull(r.lotId);
        const auctionId = intOrNull(r.auctionId);
        if (
          lotId == null ||
          auctionId == null ||
          !validLotIds.has(lotId) ||
          lotAuctionIds.get(lotId) !== auctionId
        ) {
          stoppedSkipped++;
          continue;
        }
        const stoppedAt =
          r.stoppedAt == null || String(r.stoppedAt).trim() === ""
            ? null
            : String(r.stoppedAt);

        stoppedRows.push({ id: lotId, auction_id: auctionId, stopped_at: stoppedAt });
        stoppedUpdated++;
      }
      await updateBatched(client, "no-bid extension stopped", UPDATE_STOPPED_SQL, stoppedRows);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Backfilled bid stats on ${bidStatsUpdated} auction_lots ` +
        `(${bidStatsSkipped} skipped: lot not in Postgres); ` +
        `marked ${stoppedUpdated} lots no-bid extension stopped ` +
        `(${stoppedSkipped} skipped: lot/auction not in Postgres or auction mismatch) ` +
        `in ${Date.now() - started}ms.`,
    );
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

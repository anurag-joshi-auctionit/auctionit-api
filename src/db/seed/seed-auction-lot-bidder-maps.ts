import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import {
  countMssqlRows,
  fetchMssqlBatches,
  resolveSeedBatchSize,
} from "./batch-mssql.js";
import { connectMssql } from "./mssql.js";

const SOURCE_FROM = "tbl_Data_Auction_BidderComp_Map";

const SOURCE_SELECT_LIST = `
  Id AS id,
  AuctionId AS auctionId,
  ClientId AS clientId,
  BidderCompId AS bidderId,
  LotId AS lotId,
  IsEMDWithClient AS isEmdWithClient,
  IsActive AS isActive,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy AS updatedBy
`;

const UPSERT_SQL = `
INSERT INTO auction_lot_bidder_maps (
  id, auction_id, client_id, bidder_id, lot_id, is_emd_with_client,
  is_active, created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10, $11
)
ON CONFLICT (id) DO UPDATE SET
  auction_id = EXCLUDED.auction_id,
  client_id = EXCLUDED.client_id,
  bidder_id = EXCLUDED.bidder_id,
  lot_id = EXCLUDED.lot_id,
  is_emd_with_client = EXCLUDED.is_emd_with_client,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

/**
 * Chunked insert: skips rows that would clash on the "one active map per
 * (auction, lot, bidder)" unique index with a different id already in the
 * table. Clashes inside one chunk are dropped in Node before this runs.
 */
const UPSERT_CHUNK_SQL = `
INSERT INTO auction_lot_bidder_maps (
  id, auction_id, client_id, bidder_id, lot_id, is_emd_with_client,
  is_active, created_at, created_by, updated_at, updated_by
)
SELECT
  v.id, v.auction_id, v.client_id, v.bidder_id, v.lot_id, v.is_emd_with_client,
  v.is_active, v.created_at, v.created_by, v.updated_at, v.updated_by
FROM json_populate_recordset(NULL::auction_lot_bidder_maps, $1::json) v
WHERE NOT (
  v.is_active AND v.lot_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM auction_lot_bidder_maps m
    WHERE m.auction_id = v.auction_id
      AND m.lot_id = v.lot_id
      AND m.bidder_id = v.bidder_id
      AND m.is_active
      AND m.id <> v.id
  )
)
ON CONFLICT (id) DO UPDATE SET
  auction_id = EXCLUDED.auction_id,
  client_id = EXCLUDED.client_id,
  bidder_id = EXCLUDED.bidder_id,
  lot_id = EXCLUDED.lot_id,
  is_emd_with_client = EXCLUDED.is_emd_with_client,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

/** Rows per chunked insert inside one MSSQL page. JSON has no bind-param limit. */
const CHUNK_SIZE = 5000;

type MapRow = {
  id: number;
  auction_id: number;
  client_id: number;
  bidder_id: number;
  lot_id: number | null;
  is_emd_with_client: boolean;
  is_active: boolean;
  created_at: string;
  created_by: number;
  updated_at: string | null;
  updated_by: number | null;
};

/** Row-at-a-time fallback for a chunk that still hits a unique violation. */
async function upsertRowByRow(
  client: pg.PoolClient,
  rows: MapRow[],
): Promise<{ upserted: number; duplicates: number }> {
  let upserted = 0;
  let duplicates = 0;
  for (const m of rows) {
    await client.query("SAVEPOINT before_row");
    try {
      await client.query(UPSERT_SQL, [
        m.id,
        m.auction_id,
        m.client_id,
        m.bidder_id,
        m.lot_id,
        m.is_emd_with_client,
        m.is_active,
        m.created_at,
        m.created_by,
        m.updated_at,
        m.updated_by,
      ]);
      await client.query("RELEASE SAVEPOINT before_row");
      upserted++;
    } catch (rowErr: any) {
      await client.query("ROLLBACK TO SAVEPOINT before_row");
      await client.query("RELEASE SAVEPOINT before_row");
      if (rowErr.code === "23505") {
        duplicates++;
      } else {
        throw rowErr;
      }
    }
  }
  return { upserted, duplicates };
}

type SourceRow = {
  id: number;
  auctionId: number;
  clientId: number;
  bidderId: number;
  lotId: number | null;
  isEmdWithClient: boolean | number | string | null;
  isActive: boolean | number | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string | null;
  updatedBy: number | null;
};

function asEmdWithClient(value: boolean | number | string | null): boolean {
  return (
    value === true ||
    value === 1 ||
    value === "Y" ||
    value === "y" ||
    value === "1"
  );
}

async function main() {
  const started = Date.now();
  const batchSize = resolveSeedBatchSize();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  const startFromId = process.env.SEED_START_FROM_ID
    ? Number(process.env.SEED_START_FROM_ID)
    : 0;

  try {
    const totalSource = await countMssqlRows(mssqlPool, SOURCE_FROM);
    const totalBatches = Math.max(1, Math.ceil(totalSource / batchSize));
    console.log(
      `Source has ${totalSource} bidder map rows; batching ${batchSize}/page (~${totalBatches} batches).` +
        (startFromId > 0 ? ` Resuming from id > ${startFromId}.` : ""),
    );

    if (totalSource === 0) {
      console.log("Nothing to seed.");
      console.log("SEED_OUTCOME ok skipped=0");
      return;
    }

    const [auctionIds, clientIds, bidderIds, userIds, lotIds] =
      await Promise.all([
        pgPool.query<{ id: number }>("SELECT auction_id AS id FROM auctions"),
        pgPool.query<{ id: number }>("SELECT id FROM clients"),
        pgPool.query<{ id: number }>("SELECT id FROM bidders"),
        pgPool.query<{ id: number }>("SELECT id FROM users"),
        pgPool.query<{ id: number }>("SELECT id FROM auction_lots"),
      ]);

    const validAuctionIds = new Set(auctionIds.rows.map((r) => r.id));
    const validClientIds = new Set(clientIds.rows.map((r) => r.id));
    const validBidderIds = new Set(bidderIds.rows.map((r) => r.id));
    const validUserIds = new Set(userIds.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);
    const validLotIds = new Set(lotIds.rows.map((r) => r.id));

    let upserted = 0;
    let skippedMissingAuction = 0;
    let skippedMissingClient = 0;
    let skippedMissingBidder = 0;
    let skippedDuplicate = 0;

    for await (const page of fetchMssqlBatches<SourceRow>(mssqlPool, {
      selectList: SOURCE_SELECT_LIST,
      fromClause: SOURCE_FROM,
      idColumn: "Id",
      getRowId: (r) => Number(r.id),
      batchSize,
      startFromId: startFromId > 0 ? startFromId : undefined,
    })) {
      const client = await pgPool.connect();
      let batchUpserted = 0;
      let batchSkippedMissingAuction = 0;
      let batchSkippedMissingClient = 0;
      let batchSkippedMissingBidder = 0;
      let batchSkippedDuplicate = 0;
      try {
        await client.query("BEGIN");
        const mapRows: MapRow[] = [];
        const activeLotKeys = new Set<string>();
        for (const r of page.rows) {
          if (!validAuctionIds.has(r.auctionId)) {
            batchSkippedMissingAuction++;
            continue;
          }
          if (!validClientIds.has(r.clientId)) {
            batchSkippedMissingClient++;
            continue;
          }
          if (!validBidderIds.has(r.bidderId)) {
            batchSkippedMissingBidder++;
            continue;
          }

          const lotId =
            r.lotId != null && validLotIds.has(r.lotId) ? r.lotId : null;
          const isActive = Boolean(r.isActive);
          if (isActive && lotId != null) {
            // Rows arrive in id order, so the lowest id keeps the active combo.
            const k = `${r.auctionId}:${lotId}:${r.bidderId}`;
            if (activeLotKeys.has(k)) {
              batchSkippedDuplicate++;
              continue;
            }
            activeLotKeys.add(k);
          }

          mapRows.push({
            id: r.id,
            auction_id: r.auctionId,
            client_id: r.clientId,
            bidder_id: r.bidderId,
            lot_id: lotId,
            is_emd_with_client: asEmdWithClient(r.isEmdWithClient),
            is_active: isActive,
            created_at: r.createdAt,
            created_by: resolveAuditUserId(r.createdBy, validUserIds),
            updated_at: r.updatedAt,
            updated_by: resolveAuditUserIdIfTimestamp(
              r.updatedAt,
              r.updatedBy,
              validUserIds,
            ),
          });
        }

        for (let i = 0; i < mapRows.length; i += CHUNK_SIZE) {
          const chunk = mapRows.slice(i, i + CHUNK_SIZE);
          await client.query("SAVEPOINT before_chunk");
          try {
            const res = await client.query(UPSERT_CHUNK_SQL, [
              JSON.stringify(chunk),
            ]);
            await client.query("RELEASE SAVEPOINT before_chunk");
            batchUpserted += res.rowCount ?? 0;
            batchSkippedDuplicate += chunk.length - (res.rowCount ?? 0);
          } catch (chunkErr: any) {
            await client.query("ROLLBACK TO SAVEPOINT before_chunk");
            await client.query("RELEASE SAVEPOINT before_chunk");
            if (chunkErr.code !== "23505") throw chunkErr;
            const fallback = await upsertRowByRow(client, chunk);
            batchUpserted += fallback.upserted;
            batchSkippedDuplicate += fallback.duplicates;
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      upserted += batchUpserted;
      skippedMissingAuction += batchSkippedMissingAuction;
      skippedMissingClient += batchSkippedMissingClient;
      skippedMissingBidder += batchSkippedMissingBidder;
      skippedDuplicate += batchSkippedDuplicate;
      console.log(
        `Batch ${page.batchIndex}/${totalBatches}: pulled ${page.rows.length} rows (lastId=${page.lastId}); ` +
          `upserted ${batchUpserted}, ` +
          `${batchSkippedMissingAuction} skipped: auction not in Postgres, ` +
          `${batchSkippedMissingClient} skipped: client not in Postgres, ` +
          `${batchSkippedMissingBidder} skipped: bidder not in Postgres` +
          (batchSkippedDuplicate ? `, ${batchSkippedDuplicate} skipped: duplicate active lot-bidder combo` : "") +
          ".",
      );
    }

    const skipped =
      skippedMissingAuction + skippedMissingClient + skippedMissingBidder + skippedDuplicate;
    console.log(
      `Upserted ${upserted} auction_lot_bidder_maps ` +
        `(${skippedMissingAuction} skipped: auction not in Postgres, ` +
        `${skippedMissingClient} skipped: client not in Postgres, ` +
        `${skippedMissingBidder} skipped: bidder not in Postgres, ` +
        `${skippedDuplicate} skipped: duplicate active lot-bidder combo) ` +
        `in ${Date.now() - started}ms.`,
    );
    console.log(
      `SEED_OUTCOME ${skipped > 0 ? "warn" : "ok"} skipped=${skipped}`,
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

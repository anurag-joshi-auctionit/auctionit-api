import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";

const SOURCE_SQL = `
SELECT
  LotEMDId AS id,
  AuctionId AS auctionId,
  DisplayOrderFrom AS lotDisplayOrderFrom,
  DisplayOrderTo AS lotDisplayOrderTo,
  EMD AS emdAmount,
  LotEMDDisplayOrder AS displayOrder,
  CONVERT(varchar(33), CreatedOn, 126) AS createdAt,
  CreatedBy AS createdBy,
  CONVERT(varchar(33), UpdatedOn, 126) AS updatedAt,
  UpdatedBy AS updatedBy
FROM tbl_Config_AuctionLotEMD
ORDER BY LotEMDId
`;

const UPSERT_SQL = `
INSERT INTO auction_lot_emd_ranges (
  id, auction_id, lot_display_order_from, lot_display_order_to, emd_amount,
  display_order, created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9, $10
)
ON CONFLICT (id) DO UPDATE SET
  auction_id = EXCLUDED.auction_id,
  lot_display_order_from = EXCLUDED.lot_display_order_from,
  lot_display_order_to = EXCLUDED.lot_display_order_to,
  emd_amount = EXCLUDED.emd_amount,
  display_order = EXCLUDED.display_order,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query(SOURCE_SQL);
    console.log(`Pulled ${result.recordset.length} lot EMD range rows from MSSQL.`);

    const [auctionIds, userIds] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT auction_id AS id FROM auctions"),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
    ]);
    const validAuctionIds = new Set(auctionIds.rows.map((r) => r.id));
    const validUserIds = new Set(userIds.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);

    const client = await pgPool.connect();
    let upserted = 0;
    let skippedMissingAuction = 0;

    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        if (!validAuctionIds.has(r.auctionId)) {
          skippedMissingAuction++;
          continue;
        }
        const createdBy = resolveAuditUserId(r.createdBy, validUserIds);
        const updatedBy = resolveAuditUserIdIfTimestamp(
          r.updatedAt,
          r.updatedBy,
          validUserIds,
        );

        await client.query(UPSERT_SQL, [
          r.id,
          r.auctionId,
          String(r.lotDisplayOrderFrom),
          String(r.lotDisplayOrderTo),
          String(r.emdAmount),
          r.displayOrder,
          r.createdAt,
          createdBy,
          r.updatedAt,
          updatedBy,
        ]);
        upserted++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Upserted ${upserted} auction_lot_emd_ranges ` +
        `(${skippedMissingAuction} skipped: auction not in Postgres) ` +
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

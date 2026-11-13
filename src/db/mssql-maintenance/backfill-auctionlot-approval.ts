import mssql from "mssql";
import { env } from "../../env.js";

const BACKFILL_UPDATE_SQL = `
UPDATE al
SET
  IsApproved = item_agg.is_approved,
  approval_date = item_agg.approval_date
FROM tbl_Data_AuctionLot al
INNER JOIN (
  SELECT
    ClientId,
    LotID,
    CAST(MIN(CAST(COALESCE(IsApproved, 0) AS int)) AS bit) AS is_approved,
    MIN(ApprovalDate) AS approval_date
  FROM tbl_Data_Auction_Lot_Items
  GROUP BY ClientId, LotID
) item_agg
  ON al.ClientId = item_agg.ClientId
 AND al.LotID = item_agg.LotID
`;

const DRY_RUN_COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM (
    SELECT DISTINCT ClientId, LotID FROM tbl_Data_Auction_Lot_Items
  ) t) AS lots_with_items,
  (SELECT COUNT(*) FROM tbl_Data_AuctionLot) AS total_auction_lots
`;

const DRY_RUN_SAMPLE_SQL = `
SELECT TOP 5
  item_agg.ClientId,
  item_agg.LotID,
  item_agg.is_approved,
  item_agg.approval_date,
  al.IsApproved AS current_is_approved,
  al.approval_date AS current_approval_date
FROM (
  SELECT
    ClientId,
    LotID,
    CAST(MIN(CAST(COALESCE(IsApproved, 0) AS int)) AS bit) AS is_approved,
    MIN(ApprovalDate) AS approval_date
  FROM tbl_Data_Auction_Lot_Items
  GROUP BY ClientId, LotID
) item_agg
INNER JOIN tbl_Data_AuctionLot al
  ON al.ClientId = item_agg.ClientId AND al.LotID = item_agg.LotID
ORDER BY CASE WHEN item_agg.approval_date IS NULL THEN 1 ELSE 0 END, item_agg.approval_date DESC
`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pool = await mssql.connect({
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    server: env.MSSQL_SERVER,
    port: env.MSSQL_PORT,
    database: env.MSSQL_DATABASE,
    options: {
      encrypt: env.MSSQL_ENCRYPT,
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
    },
  });
  const started = Date.now();

  try {
    if (dryRun) {
      const counts = await pool.request().query(DRY_RUN_COUNTS_SQL);
      const sample = await pool.request().query(DRY_RUN_SAMPLE_SQL);
      console.log("Dry run — no rows updated.");
      console.log("Counts:", counts.recordset[0]);
      console.log("Sample (up to 5 lots with items):");
      console.table(sample.recordset);
      return;
    }

    const transaction = new mssql.Transaction(pool);
    await transaction.begin();
    try {
      const request = new mssql.Request(transaction);
      const result = await request.query(BACKFILL_UPDATE_SQL);
      await transaction.commit();
      const elapsedMs = Date.now() - started;
      console.log(
        `Backfilled IsApproved and approval_date on tbl_Data_AuctionLot: ${result.rowsAffected[0] ?? 0} rows updated in ${elapsedMs}ms`,
      );
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

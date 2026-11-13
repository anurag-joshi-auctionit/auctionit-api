import mssql from "mssql";
import { env } from "../../env.js";

const BACKFILL_UPDATE_SQL = `
UPDATE al
SET
  latest_lifted_status = latest.LiftingStatus,
  latest_lifted_date = latest.LiftingDate,
  latest_lifted_qty = qty_agg.total_qty
FROM tbl_Data_AuctionLot al
INNER JOIN (
  SELECT ClientId, LotId, LiftingStatus, LiftingDate
  FROM (
    SELECT
      ClientId,
      LotId,
      LiftingStatus,
      LiftingDate,
      ROW_NUMBER() OVER (PARTITION BY ClientId, LotId ORDER BY AuctionLoftingLotId DESC) AS rn
    FROM tbl_Data_AuctionLiftingLot
  ) t
  WHERE rn = 1
) latest
  ON al.ClientId = latest.ClientId
 AND al.LotID = latest.LotId
INNER JOIN (
  SELECT
    ClientId,
    LotId,
    COALESCE(SUM(CAST(Qty AS decimal(38, 3))), 0) AS total_qty
  FROM tbl_Data_AuctionLiftingLot
  GROUP BY ClientId, LotId
) qty_agg
  ON qty_agg.ClientId = latest.ClientId
 AND qty_agg.LotId = latest.LotId
`;

const RESTORE_APPROVED_OPEN_STATUS_SQL = `
UPDATE al
SET latest_lifted_status = 1
FROM tbl_Data_AuctionLot al
WHERE al.IsApproved = 1
  AND al.ClientId NOT IN (2, 3)
  AND NOT EXISTS (
    SELECT 1
    FROM tbl_Data_AuctionLiftingLot ll
    WHERE ll.ClientId = al.ClientId
      AND ll.LotId = al.LotID
  )
`;

const DRY_RUN_COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM (
    SELECT DISTINCT ClientId, LotId FROM tbl_Data_AuctionLiftingLot
  ) t) AS lots_with_lifting_rows,
  (SELECT COUNT(*) FROM tbl_Data_AuctionLot) AS total_auction_lots
`;

const DRY_RUN_SAMPLE_SQL = `
WITH latest AS (
  SELECT ClientId, LotId, LiftingStatus, LiftingDate, AuctionLoftingLotId
  FROM (
    SELECT
      ClientId,
      LotId,
      LiftingStatus,
      LiftingDate,
      AuctionLoftingLotId,
      ROW_NUMBER() OVER (PARTITION BY ClientId, LotId ORDER BY AuctionLoftingLotId DESC) AS rn
    FROM tbl_Data_AuctionLiftingLot
  ) t
  WHERE rn = 1
),
qty_agg AS (
  SELECT ClientId, LotId, COALESCE(SUM(CAST(Qty AS decimal(38, 3))), 0) AS total_qty
  FROM tbl_Data_AuctionLiftingLot
  GROUP BY ClientId, LotId
)
SELECT TOP 5
  latest.ClientId,
  latest.LotId,
  latest.LiftingStatus,
  latest.LiftingDate,
  latest.AuctionLoftingLotId,
  qty_agg.total_qty
FROM latest
INNER JOIN qty_agg
  ON qty_agg.ClientId = latest.ClientId AND qty_agg.LotId = latest.LotId
ORDER BY latest.AuctionLoftingLotId DESC
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
      console.log("Sample (up to 5 lots with lifting history):");
      console.table(sample.recordset);
      return;
    }

    const transaction = new mssql.Transaction(pool);
    await transaction.begin();
    try {
      const request = new mssql.Request(transaction);
      const result = await request.query(BACKFILL_UPDATE_SQL);
      const restored = await request.query(RESTORE_APPROVED_OPEN_STATUS_SQL);
      await transaction.commit();
      const elapsedMs = Date.now() - started;
      console.log(
        `Backfilled latest_lifted_* on tbl_Data_AuctionLot: ${result.rowsAffected[0] ?? 0} rows updated in ${elapsedMs}ms`,
      );
      console.log(
        `Set open status on approved lots without lifting history: ${restored.rowsAffected[0] ?? 0} rows`,
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

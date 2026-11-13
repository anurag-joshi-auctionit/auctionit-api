import pg from "pg";
import { env } from "../env.js";

const BACKFILL_UPDATE_SQL = `
UPDATE tbl_data_auctionlot al
SET
  is_approved = item_agg.is_approved,
  approval_date = item_agg.approval_date
FROM (
  SELECT
    client_id,
    lot_id,
    BOOL_AND(is_approved) AS is_approved,
    MIN(approval_date) AS approval_date
  FROM tbl_data_auction_lot_items
  GROUP BY client_id, lot_id
) item_agg
WHERE al.client_id = item_agg.client_id
  AND al.lot_id = item_agg.lot_id
`;

const DRY_RUN_COUNTS_SQL = `
SELECT
  (SELECT COUNT(DISTINCT (client_id, lot_id)) FROM tbl_data_auction_lot_items) AS lots_with_items,
  (SELECT COUNT(*) FROM tbl_data_auctionlot) AS total_auction_lots
`;

const DRY_RUN_SAMPLE_SQL = `
SELECT
  item_agg.client_id,
  item_agg.lot_id,
  item_agg.is_approved,
  item_agg.approval_date,
  al.is_approved AS current_is_approved,
  al.approval_date AS current_approval_date
FROM (
  SELECT
    client_id,
    lot_id,
    BOOL_AND(is_approved) AS is_approved,
    MIN(approval_date) AS approval_date
  FROM tbl_data_auction_lot_items
  GROUP BY client_id, lot_id
) item_agg
INNER JOIN tbl_data_auctionlot al
  ON al.client_id = item_agg.client_id AND al.lot_id = item_agg.lot_id
ORDER BY item_agg.approval_date DESC NULLS LAST
LIMIT 5
`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const started = Date.now();

  try {
    if (dryRun) {
      const counts = await pool.query(DRY_RUN_COUNTS_SQL);
      const sample = await pool.query(DRY_RUN_SAMPLE_SQL);
      console.log("Dry run — no rows updated.");
      console.log("Counts:", counts.rows[0]);
      console.log("Sample (up to 5 lots with items):");
      console.table(sample.rows);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(BACKFILL_UPDATE_SQL);
      await client.query("COMMIT");
      const elapsedMs = Date.now() - started;
      console.log(
        `Backfilled is_approved and approval_date on tbl_data_auctionlot: ${result.rowCount ?? 0} rows updated in ${elapsedMs}ms`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

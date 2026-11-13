import pg from "pg";
import { env } from "../env.js";

const BACKFILL_UPDATE_SQL = `
UPDATE tbl_data_auctionlot al
SET
  latest_lifted_status = latest.lifting_status,
  latest_lifted_date = latest.lifting_date,
  latest_lifted_qty = qty_agg.total_qty
FROM (
  SELECT DISTINCT ON (client_id, lot_id)
    client_id,
    lot_id,
    lifting_status,
    lifting_date
  FROM tbl_data_auctionliftinglot
  ORDER BY client_id, lot_id, auction_lofting_lot_id DESC
) latest
INNER JOIN (
  SELECT
    client_id,
    lot_id,
    COALESCE(SUM(qty::numeric), 0) AS total_qty
  FROM tbl_data_auctionliftinglot
  GROUP BY client_id, lot_id
) qty_agg
  ON qty_agg.client_id = latest.client_id
 AND qty_agg.lot_id = latest.lot_id
WHERE al.client_id = latest.client_id
  AND al.lot_id = latest.lot_id
`;

const RESTORE_APPROVED_OPEN_STATUS_SQL = `
UPDATE tbl_data_auctionlot al
SET latest_lifted_status = 1
WHERE al.is_approved = true
  AND al.client_id NOT IN (2, 3)
  AND NOT EXISTS (
    SELECT 1
    FROM tbl_data_auctionliftinglot ll
    WHERE ll.client_id = al.client_id
      AND ll.lot_id = al.lot_id
  )
`;

const DRY_RUN_COUNTS_SQL = `
SELECT
  (SELECT COUNT(DISTINCT (client_id, lot_id)) FROM tbl_data_auctionliftinglot) AS lots_with_lifting_rows,
  (SELECT COUNT(*) FROM tbl_data_auctionlot) AS total_auction_lots
`;

const DRY_RUN_SAMPLE_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (client_id, lot_id)
    client_id,
    lot_id,
    lifting_status,
    lifting_date,
    auction_lofting_lot_id
  FROM tbl_data_auctionliftinglot
  ORDER BY client_id, lot_id, auction_lofting_lot_id DESC
),
qty_agg AS (
  SELECT client_id, lot_id, COALESCE(SUM(qty::numeric), 0) AS total_qty
  FROM tbl_data_auctionliftinglot
  GROUP BY client_id, lot_id
)
SELECT
  latest.client_id,
  latest.lot_id,
  latest.lifting_status,
  latest.lifting_date,
  latest.auction_lofting_lot_id,
  qty_agg.total_qty
FROM latest
INNER JOIN qty_agg
  ON qty_agg.client_id = latest.client_id AND qty_agg.lot_id = latest.lot_id
ORDER BY latest.auction_lofting_lot_id DESC
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
      console.log("Sample (up to 5 lots with lifting history):");
      console.table(sample.rows);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(BACKFILL_UPDATE_SQL);
      const restored = await client.query(RESTORE_APPROVED_OPEN_STATUS_SQL);
      await client.query("COMMIT");
      const elapsedMs = Date.now() - started;
      console.log(
        `Backfilled latest_lifted_* on tbl_data_auctionlot: ${result.rowCount ?? 0} rows updated in ${elapsedMs}ms`,
      );
      console.log(
        `Set open status on approved lots without lifting history: ${restored.rowCount ?? 0} rows`,
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

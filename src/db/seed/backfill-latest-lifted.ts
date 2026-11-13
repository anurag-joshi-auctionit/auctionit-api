import pg from "pg";
import { env } from "../../env.js";
import { LIFTING_EXCLUDED_CLIENT_IDS } from "../../lib/lifting-scope.js";
import { BACKFILL_LATEST_LIFTED_SQL } from "../../lib/lifting-latest-lifted-sync.js";

/**
 * Backfill `auction_lots.latest_lifted_*` from `lifting_client_logs`.
 * Also restores OPEN status (1) on approved lots with no lifting history.
 */
const BACKFILL_SQL = BACKFILL_LATEST_LIFTED_SQL;

const RESTORE_OPEN_SQL = `
UPDATE auction_lots AS al
SET latest_lifted_status = 1
WHERE al.is_approved = true
  AND al.client_id <> ALL($1::int[])
  AND NOT EXISTS (
    SELECT 1
    FROM lifting_client_logs ll
    WHERE ll.client_id = al.client_id
      AND ll.lot_id = al.id
  )
`;

const DRY_RUN_COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM (SELECT DISTINCT client_id, lot_id FROM lifting_client_logs) t) AS lots_with_lifting_rows,
  (SELECT COUNT(*) FROM auction_lots) AS total_auction_lots
`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const started = Date.now();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    if (dryRun) {
      const counts = await client.query(DRY_RUN_COUNTS_SQL);
      const sample = await client.query(`
        SELECT latest.client_id, latest.lot_id, latest.lifting_status,
               latest.lifting_date, latest.id, qty_agg.total_qty
        FROM (
          SELECT client_id, lot_id, lifting_status, lifting_date, id
          FROM (
            SELECT
              client_id, lot_id, lifting_status, lifting_date, id,
              ROW_NUMBER() OVER (PARTITION BY client_id, lot_id ORDER BY id DESC) AS rn
            FROM lifting_client_logs
          ) t
          WHERE rn = 1
        ) latest
        INNER JOIN (
          SELECT client_id, lot_id, COALESCE(SUM(CAST(qty AS decimal(38, 3))), 0) AS total_qty
          FROM lifting_client_logs
          GROUP BY client_id, lot_id
        ) qty_agg
          ON qty_agg.client_id = latest.client_id AND qty_agg.lot_id = latest.lot_id
        ORDER BY latest.id DESC
        LIMIT 5
      `);
      console.log("Dry run — no rows updated.");
      console.log("Counts:", counts.rows[0]);
      console.log("Sample (up to 5 lots with lifting history):");
      console.table(sample.rows);
      return;
    }

    await client.query("BEGIN");
    try {
      const backfill = await client.query(BACKFILL_SQL);
      const restored = await client.query(RESTORE_OPEN_SQL, [
        [...LIFTING_EXCLUDED_CLIENT_IDS],
      ]);
      await client.query("COMMIT");
      console.log(
        `Backfilled latest_lifted_* on auction_lots: ${backfill.rowCount ?? 0} rows in ${Date.now() - started}ms`,
      );
      console.log(
        `Set open status on approved lots without lifting history: ${restored.rowCount ?? 0} rows`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

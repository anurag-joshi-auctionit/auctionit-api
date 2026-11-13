import pg from "pg";
import { env } from "../../env.js";
import {
  LIFTING_BIDDER_DISPOSITION,
  LIFTING_BIDDER_DISPOSITION_LABELS,
  LIFTING_BIDDER_REQUIRES_LIFTED_QTY_IDS,
  LIFTING_BIDDER_REQUIRES_NEXT_FOLLOWUP_IDS,
  LIFTING_CLIENT_DISPOSITION,
  LIFTING_CLIENT_DISPOSITION_LABELS,
} from "../../lib/masters/status-keys.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

const CLIENT_ROWS = (
  Object.values(LIFTING_CLIENT_DISPOSITION) as number[]
).map((id) => ({
  id,
  label: LIFTING_CLIENT_DISPOSITION_LABELS[id as keyof typeof LIFTING_CLIENT_DISPOSITION_LABELS],
}));

const BIDDER_ROWS = (
  Object.values(LIFTING_BIDDER_DISPOSITION) as number[]
).map((id) => ({
  id,
  label: LIFTING_BIDDER_DISPOSITION_LABELS[id as keyof typeof LIFTING_BIDDER_DISPOSITION_LABELS],
  requiresLiftedQty: LIFTING_BIDDER_REQUIRES_LIFTED_QTY_IDS.has(id),
  requiresNextFollowup: LIFTING_BIDDER_REQUIRES_NEXT_FOLLOWUP_IDS.has(id),
}));

async function main() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  const started = Date.now();

  try {
    await client.query("BEGIN");

    for (const row of CLIENT_ROWS) {
      await client.query(
        `
        INSERT INTO lifting_client_dispositions
          (id, label, description, is_active, created_at, created_by)
        VALUES ($1, $2, '', true, NOW(), $3)
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          is_active = EXCLUDED.is_active,
          created_by = COALESCE(lifting_client_dispositions.created_by, EXCLUDED.created_by)
        `,
        [row.id, row.label, SEED_DEFAULT_USER_ID],
      );
    }

    for (const row of BIDDER_ROWS) {
      await client.query(
        `
        INSERT INTO lifting_bidder_dispositions
          (id, label, description, is_active, requires_lifted_qty,
           requires_next_followup, created_at, created_by)
        VALUES ($1, $2, '', true, $3, $4, NOW(), $5)
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          is_active = EXCLUDED.is_active,
          requires_lifted_qty = EXCLUDED.requires_lifted_qty,
          requires_next_followup = EXCLUDED.requires_next_followup,
          created_by = COALESCE(lifting_bidder_dispositions.created_by, EXCLUDED.created_by)
        `,
        [
          row.id,
          row.label,
          row.requiresLiftedQty,
          row.requiresNextFollowup,
          SEED_DEFAULT_USER_ID,
        ],
      );
    }

    await client.query(
      `SELECT setval(pg_get_serial_sequence('lifting_bidder_dispositions', 'id'), (SELECT COALESCE(MAX(id), 1) FROM lifting_bidder_dispositions))`,
    );

    await client.query("COMMIT");

    const [clientCount, bidderCount] = await Promise.all([
      client.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM lifting_client_dispositions",
      ),
      client.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM lifting_bidder_dispositions",
      ),
    ]);

    console.log(
      `Seeded lifting dispositions: ${clientCount.rows[0]?.cnt ?? 0} client, ${bidderCount.rows[0]?.cnt ?? 0} bidder rows in ${Date.now() - started}ms.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

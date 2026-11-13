import pg from "pg";
import { env } from "../../env.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

/**
 * Backfill nullable audit actor columns on editable masters to user id 1.
 * Run after db:push and seed:bootstrap-user (user 1 must exist).
 */
async function main() {
  const started = Date.now();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const user = await client.query(
      `SELECT 1 FROM users WHERE id = $1`,
      [SEED_DEFAULT_USER_ID],
    );
    if (!user.rowCount) {
      throw new Error(
        `users.id=${SEED_DEFAULT_USER_ID} missing. Run seed:bootstrap-user first.`,
      );
    }

    const statements: Array<{ label: string; sql: string }> = [
      {
        label: "roles.created_by",
        sql: `UPDATE roles SET created_by = $1 WHERE created_by IS NULL`,
      },
      {
        label: "uoms.created_by",
        sql: `UPDATE uoms SET created_by = $1 WHERE created_by IS NULL`,
      },
      {
        label: "materials.created_by",
        sql: `UPDATE materials SET created_by = $1 WHERE created_by IS NULL`,
      },
      {
        label: "materials.updated_by",
        sql: `UPDATE materials SET updated_by = $1 WHERE updated_at IS NOT NULL AND updated_by IS NULL`,
      },
      {
        label: "payment_types.created_by",
        sql: `UPDATE payment_types SET created_by = $1 WHERE created_by IS NULL`,
      },
      {
        label: "payment_types.updated_by",
        sql: `UPDATE payment_types SET updated_by = $1 WHERE updated_at IS NOT NULL AND updated_by IS NULL`,
      },
      {
        label: "lifting_client_dispositions.created_by",
        sql: `UPDATE lifting_client_dispositions SET created_by = $1 WHERE created_by IS NULL`,
      },
      {
        label: "lifting_bidder_dispositions.created_by",
        sql: `UPDATE lifting_bidder_dispositions SET created_by = $1 WHERE created_by IS NULL`,
      },
      {
        label: "role_permissions.updated_by",
        sql: `UPDATE role_permissions SET updated_by = $1 WHERE updated_at IS NOT NULL AND updated_by IS NULL`,
      },
    ];

    await client.query("BEGIN");
    for (const stmt of statements) {
      const r = await client.query(stmt.sql, [SEED_DEFAULT_USER_ID]);
      console.log(`Backfilled ${stmt.label}: ${r.rowCount ?? 0} rows`);
    }
    await client.query("COMMIT");

    console.log(`Audit actor backfill done in ${Date.now() - started}ms.`);
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

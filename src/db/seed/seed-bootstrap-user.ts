import pg from "pg";
import { hashPasswordForStorage } from "../../auth/hash.js";
import { env } from "../../env.js";
import { ROLE_CODES } from "../schema/roles.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

/** Shared password for bootstrap system user (same as seed:users). */
const SEED_PASSWORD = "Welcome@123";

/**
 * Ensures users.id = 1 exists so Phase A seeds can set created_by / updated_by = 1.
 * Idempotent: does nothing if the row already exists. Full user data comes from seed:users.
 */
async function main() {
  const started = Date.now();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM users WHERE id = $1`,
      [SEED_DEFAULT_USER_ID],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      console.log(
        `Bootstrap user ${SEED_DEFAULT_USER_ID} already exists ` +
          `(${Date.now() - started}ms).`,
      );
      return;
    }

    const role = await client.query<{ id: number }>(
      `SELECT id FROM roles WHERE code = $1 LIMIT 1`,
      [ROLE_CODES.admin],
    );
    if (!role.rows[0]) {
      throw new Error(
        `Cannot bootstrap user ${SEED_DEFAULT_USER_ID}: role "${ROLE_CODES.admin}" not found. Run seed:roles first.`,
      );
    }

    const now = new Date().toISOString();
    const password = await hashPasswordForStorage(SEED_PASSWORD);

    await client.query(
      `
      INSERT INTO users (
        id, user_login_name, name, email_id,
        password, password_changed, password_algo,
        role_id, is_owner, is_active, is_old_design,
        created_at, created_by
      ) VALUES (
        $1, $2, $3, $4,
        $5, true, $6,
        $7, false, true, false,
        $8, $1
      )
      ON CONFLICT (id) DO NOTHING
      `,
      [
        SEED_DEFAULT_USER_ID,
        "system",
        "System",
        null,
        password.hash,
        password.algo,
        role.rows[0].id,
        now,
      ],
    );

    console.log(
      `Bootstrapped users.id=${SEED_DEFAULT_USER_ID} (system) ` +
        `in ${Date.now() - started}ms.`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import pg from "pg";
import {
  ADMIN_DEFAULT_PERMISSION_KEYS,
  ADMIN_EXCLUDED_DEFAULT_KEYS,
  PERMISSION_CATALOG,
  SEED_ROLE_PERMISSION_DEFAULTS,
} from "@auctionit/authz";
import { env } from "../../env.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

/**
 * Upsert permission catalog and apply default enabled flags for known roles.
 * Safe to re-run: catalog metadata updates; defaults only enable rows that are
 * still disabled (never disables an already-enabled grant). Exception: on
 * `is_admin` roles the Accounts/HOD stage keys (`ADMIN_EXCLUDED_DEFAULT_KEYS`)
 * are always turned off, so reseeding enforces that separation.
 */
async function main() {
  const started = Date.now();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── 1. Rename legacy keys ────────────────────────────────────────────────
    await client.query(`
      UPDATE permissions
      SET key = 'module.portal-client-dashboard',
          label = 'Client portal dashboard',
          description = 'External portal client dashboard',
          updated_at = now()
      WHERE key = 'module.portal-client-overview'
        AND NOT EXISTS (
          SELECT 1 FROM permissions WHERE key = 'module.portal-client-dashboard'
        )
    `);
    await client.query(`
      UPDATE permissions
      SET key = 'auction.live.auctions',
          label = 'Live auctions',
          description = 'View live auctions',
          updated_at = now()
      WHERE key = 'auction.live.monitor'
        AND NOT EXISTS (
          SELECT 1 FROM permissions WHERE key = 'auction.live.auctions'
        )
    `);

    // ── 2. Bulk-upsert permission catalog (single round-trip) ────────────────
    const keys = PERMISSION_CATALOG.map((e) => e.key);
    const labels = PERMISSION_CATALOG.map((e) => e.label);
    const descriptions = PERMISSION_CATALOG.map((e) => e.description);
    const groups = PERMISSION_CATALOG.map((e) => e.group);

    await client.query(`
      INSERT INTO permissions (key, label, description, "group")
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
        AS t(key, label, description, grp)
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        "group" = EXCLUDED."group",
        updated_at = now()
    `, [keys, labels, descriptions, groups]);

    console.log(`  [1/3] Upserted ${PERMISSION_CATALOG.length} permissions`);

    // ── 3. Load roles + fresh permission ids ─────────────────────────────────
    const rolesRes = await client.query<{ id: number; code: string; is_admin: boolean }>(
      "SELECT id, code, is_admin FROM roles",
    );
    const permsRes = await client.query<{ id: number; key: string }>(
      "SELECT id, key FROM permissions",
    );
    const permByKey = new Map(permsRes.rows.map((p) => [p.key, p.id]));
    const allPermIds = permsRes.rows.map((p) => p.id);

    const userExists = await client.query(`SELECT 1 FROM users WHERE id = $1`, [SEED_DEFAULT_USER_ID]);
    const updatedBy = userExists.rowCount && userExists.rowCount > 0 ? SEED_DEFAULT_USER_ID : null;

    console.log(`  [2/3] Processing ${rolesRes.rows.length} roles…`);

    // ── 4. Per-role: bulk insert placeholders, bulk enable/disable ───────────
    for (const role of rolesRes.rows) {
      // Insert missing role_permissions rows in one shot
      const roleIds = allPermIds.map(() => role.id);
      const updatedBys = allPermIds.map(() => updatedBy);
      await client.query(`
        INSERT INTO role_permissions (role_id, permission_id, enabled, updated_by)
        SELECT * FROM unnest($1::int[], $2::int[], $3::bool[], $4::int[])
          AS t(role_id, permission_id, enabled, updated_by)
        ON CONFLICT (role_id, permission_id) DO NOTHING
      `, [roleIds, allPermIds, allPermIds.map(() => false), updatedBys]);

      // Enable defaults in bulk
      const defaults = role.is_admin
        ? ADMIN_DEFAULT_PERMISSION_KEYS
        : (SEED_ROLE_PERMISSION_DEFAULTS[role.code] ?? []);
      const enableIds = defaults.map((k) => permByKey.get(k)).filter((id): id is number => id !== undefined);
      if (enableIds.length > 0) {
        await client.query(`
          UPDATE role_permissions
          SET enabled = true, updated_at = now(), updated_by = $3
          WHERE role_id = $1
            AND permission_id = ANY($2::int[])
            AND enabled = false
        `, [role.id, enableIds, updatedBy]);
      }

      // Disable excluded keys for admin roles
      if (role.is_admin) {
        const disableIds = ADMIN_EXCLUDED_DEFAULT_KEYS
          .map((k) => permByKey.get(k))
          .filter((id): id is number => id !== undefined);
        if (disableIds.length > 0) {
          await client.query(`
            UPDATE role_permissions
            SET enabled = false, updated_at = now(), updated_by = $3
            WHERE role_id = $1
              AND permission_id = ANY($2::int[])
              AND enabled = true
          `, [role.id, disableIds, updatedBy]);
        }
      }

      console.log(`    role "${role.code}" done`);
    }

    await client.query("COMMIT");
    console.log(
      `\n  [3/3] Done — ${PERMISSION_CATALOG.length} permissions × ${rolesRes.rows.length} roles in ${Date.now() - started}ms.`,
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

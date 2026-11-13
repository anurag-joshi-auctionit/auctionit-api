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

    // Rename in place so existing role grants stay attached to the same row.
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

    for (const entry of PERMISSION_CATALOG) {
      await client.query(
        `
        INSERT INTO permissions (key, label, description, "group")
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (key) DO UPDATE SET
          label = EXCLUDED.label,
          description = EXCLUDED.description,
          "group" = EXCLUDED."group",
          updated_at = now()
        `,
        [
          entry.key,
          entry.label,
          entry.description,
          entry.group,
        ],
      );
    }

    const rolesRes = await client.query<{
      id: number;
      code: string;
      is_admin: boolean;
    }>("SELECT id, code, is_admin FROM roles");
    const permsRes = await client.query<{ id: number; key: string }>(
      "SELECT id, key FROM permissions",
    );
    const permByKey = new Map(permsRes.rows.map((p) => [p.key, p.id]));

    // Prefer user 1 for updated_by when present (after seed:bootstrap-user).
    const userExists = await client.query(
      `SELECT 1 FROM users WHERE id = $1`,
      [SEED_DEFAULT_USER_ID],
    );
    const updatedBy =
      userExists.rowCount && userExists.rowCount > 0
        ? SEED_DEFAULT_USER_ID
        : null;

    for (const role of rolesRes.rows) {
      for (const perm of permsRes.rows) {
        await client.query(
          `
          INSERT INTO role_permissions (role_id, permission_id, enabled, updated_by)
          VALUES ($1, $2, false, $3)
          ON CONFLICT (role_id, permission_id) DO NOTHING
          `,
          [role.id, perm.id, updatedBy],
        );
      }

      const defaults = role.is_admin
        ? ADMIN_DEFAULT_PERMISSION_KEYS
        : (SEED_ROLE_PERMISSION_DEFAULTS[role.code] ?? []);
      for (const key of defaults) {
        const permissionId = permByKey.get(key);
        if (permissionId === undefined) continue;
        await client.query(
          `
          UPDATE role_permissions
          SET enabled = true, updated_at = now(), updated_by = $3
          WHERE role_id = $1 AND permission_id = $2 AND enabled = false
          `,
          [role.id, permissionId, updatedBy],
        );
      }

      if (role.is_admin) {
        for (const key of ADMIN_EXCLUDED_DEFAULT_KEYS) {
          const permissionId = permByKey.get(key);
          if (permissionId === undefined) continue;
          await client.query(
            `
            UPDATE role_permissions
            SET enabled = false, updated_at = now(), updated_by = $3
            WHERE role_id = $1 AND permission_id = $2 AND enabled = true
            `,
            [role.id, permissionId, updatedBy],
          );
        }
      }
    }

    await client.query("COMMIT");
    console.log(
      `Seeded ${PERMISSION_CATALOG.length} permissions for ${rolesRes.rows.length} roles in ${Date.now() - started}ms.`,
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

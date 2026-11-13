import pg from "pg";
import { env } from "../../env.js";

type CheckResult = { name: string; ok: boolean; detail: string };

async function runCheck(
  pool: pg.Pool,
  name: string,
  sql: string,
): Promise<CheckResult> {
  const res = await pool.query<{ count: string }>(sql);
  const count = Number(res.rows[0]?.count ?? 0);
  return {
    name,
    ok: count === 0,
    detail: count === 0 ? "ok" : `${count} row(s) failed`,
  };
}

async function main() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const checks = await Promise.all([
      runCheck(
        pool,
        "clients.location_id FK",
        `SELECT COUNT(*)::text AS count FROM clients c
         WHERE c.location_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = c.location_id)`,
      ),
      runCheck(
        pool,
        "plant_locations.client_id FK",
        `SELECT COUNT(*)::text AS count FROM plant_locations p
         WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = p.client_id)`,
      ),
      runCheck(
        pool,
        "plant_locations.location_id FK",
        `SELECT COUNT(*)::text AS count FROM plant_locations p
         WHERE p.location_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = p.location_id)`,
      ),
      runCheck(
        pool,
        "plant_locations.kam_id FK",
        `SELECT COUNT(*)::text AS count FROM plant_locations p
         WHERE p.kam_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.kam_id)`,
      ),
      runCheck(
        pool,
        "material_locations.client_id FK",
        `SELECT COUNT(*)::text AS count FROM material_locations m
         WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = m.client_id)`,
      ),
      runCheck(
        pool,
        "material_locations.location_id FK",
        `SELECT COUNT(*)::text AS count FROM material_locations m
         WHERE m.location_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = m.location_id)`,
      ),
    ]);

    const counts = await pool.query<{
      clients: string;
      plants: string;
      materials: string;
      plants_missing_kam: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM clients)::text AS clients,
        (SELECT COUNT(*) FROM plant_locations)::text AS plants,
        (SELECT COUNT(*) FROM material_locations)::text AS materials,
        (SELECT COUNT(*) FROM plant_locations WHERE kam_id IS NULL)::text AS plants_missing_kam
    `);

    console.log("Row counts:");
    console.table(counts.rows[0]);

    console.log("FK checks:");
    console.table(checks);

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      console.error(`${failed.length} check(s) failed.`);
      process.exit(1);
    }

    const missingKam = Number(counts.rows[0]?.plants_missing_kam ?? 0);
    if (missingKam > 0) {
      console.warn(
        `Warning: ${missingKam} plant location(s) have no kam_id assigned.`,
      );
    }

    console.log("All FK checks passed.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import pg from "pg";
import { env } from "../env.js";

/**
 * Drops every table in the public schema (CASCADE), including Drizzle's
 * migration journal. Re-run `pnpm db:migrate` afterward to rebuild.
 *
 * Usage:
 *   pnpm db:drop-all          # dry run — lists tables, does nothing
 *   pnpm db:drop-all -- --yes # actually drop
 */
async function main() {
  const yes =
    process.argv.includes("--yes") || process.argv.includes("-y");

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename`,
    );

    const host = new URL(env.DATABASE_URL).host;
    const db = new URL(env.DATABASE_URL).pathname.replace(/^\//, "");
    console.log(`Target: ${db} @ ${host}`);
    console.log(`Found ${rows.length} table(s) in public schema.`);
    if (rows.length > 0) {
      console.log(rows.map((r) => `  - ${r.tablename}`).join("\n"));
    }

    if (!yes) {
      console.log(
        "\nDry run — nothing was dropped. Re-run with --yes to drop all tables.",
      );
      return;
    }

    if (rows.length === 0) {
      console.log("Nothing to drop.");
      return;
    }

    const started = Date.now();
    await pool.query(`
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
END $$;
`);

    // Also drop leftover enums/types so migrations can recreate them cleanly.
    await pool.query(`
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typtype = 'e'
    ) LOOP
        EXECUTE 'DROP TYPE IF EXISTS ' || quote_ident(r.typname) || ' CASCADE';
    END LOOP;
END $$;
`);

    const remaining = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`,
    );
    console.log(
      `Dropped all public tables (+ enums) in ${Date.now() - started}ms. Remaining: ${remaining.rows[0]!.n}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

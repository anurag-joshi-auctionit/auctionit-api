// One-shot baseline script. Marks every migration listed in
// drizzle/meta/_journal.json as already applied — useful when the database
// was provisioned by some other means (data import, existing prod DB) and
// you want to start tracking new migrations from this point on.
//
// Idempotent: rows already present in drizzle.__drizzle_migrations are
// skipped, so it's safe to re-run.
//
// Run with:  pnpm -F @auctionit/api db:baseline
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { env } from "../env.js";

type JournalEntry = {
  idx: number;
  when: number;
  tag: string;
  breakpoints?: boolean;
};

type Journal = {
  entries: JournalEntry[];
};

const MIGRATIONS_DIR = resolve(process.cwd(), "drizzle");

async function loadJournal(): Promise<Journal> {
  const raw = await readFile(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf8");
  return JSON.parse(raw) as Journal;
}

async function hashOfTag(tag: string, breakpoints: boolean): Promise<string> {
  const sql = await readFile(resolve(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  // Match Drizzle's migrator: it concatenates the statements (split on the
  // breakpoint marker) and SHA-256s the joined SQL.
  const statements = breakpoints
    ? sql.split("--> statement-breakpoint")
    : [sql];
  const joined = statements.map((s) => s.trim()).join("");
  return createHash("sha256").update(joined).digest("hex");
}

async function main() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);

      const journal = await loadJournal();
      let inserted = 0;
      let skipped = 0;
      for (const entry of journal.entries) {
        const hash = await hashOfTag(entry.tag, entry.breakpoints ?? true);
        const existing = await client.query(
          `SELECT id FROM drizzle.__drizzle_migrations WHERE hash = $1`,
          [hash],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          skipped += 1;
          console.log(`  skip  ${entry.tag} (already recorded)`);
          continue;
        }
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
          [hash, entry.when],
        );
        inserted += 1;
        console.log(`  mark  ${entry.tag} as applied`);
      }
      console.log(`\n[baseline] inserted ${inserted}, skipped ${skipped}`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[baseline] failed:", err);
  process.exit(1);
});

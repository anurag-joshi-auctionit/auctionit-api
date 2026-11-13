import pg from "pg";
import { env } from "../../env.js";

const DEFAULT_TABLES = [
    "material_locations",
    "plant_locations",
    "clients",
    "locations",
];

function parseArgs(argv: string[]): { tables: string[]; yes: boolean } {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const tableArg = argv.find((a) => a.startsWith("--tables="));
  const tables = tableArg
    ? tableArg
        .slice("--tables=".length)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : DEFAULT_TABLES;
  return { tables, yes };
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to truncate unsafe table name: ${name}`);
  }
  return `"${name}"`;
}

async function main() {
  const { tables, yes } = parseArgs(process.argv.slice(2));
  if (tables.length === 0) {
    console.error("No tables specified.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  try {
    const counts = await pool.query<{ table: string; n: string }>(
      tables
        .map(
          (t) =>
            `SELECT '${t}' AS table, COUNT(*)::text AS n FROM ${quoteIdent(t)}`,
        )
        .join(" UNION ALL "),
    );
    console.log("Row counts before clean:");
    console.table(counts.rows.map((r) => ({ table: r.table, rows: Number(r.n) })));

    if (!yes) {
      console.log(
        "\nDry run — nothing was deleted. Re-run with --yes to truncate.",
      );
      return;
    }

    const sql = `TRUNCATE ${tables.map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE`;
    const started = Date.now();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    console.log(
      `Truncated ${tables.length} table(s) (${tables.join(", ")}) in ${Date.now() - started}ms.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

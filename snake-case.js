import pg from "pg";

const pgConfig = {
  user: "postgres",
  password: "postgres",
  server: "localhost",
  database: "auctionit",
};

function toSnake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const client = new pg.Client(pgConfig);
  await client.connect();

  try {
    const { rows: cols } = await client.query(`
      SELECT table_name, column_name, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    const byTable = new Map();
    for (const c of cols) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
      byTable.get(c.table_name).push(c.column_name);
    }

    const renames = [];
    let skipped = 0;
    let collisions = 0;

    for (const [table, columnList] of byTable) {
      const finalNames = new Set(columnList.filter((c) => toSnake(c) === c));

      for (const orig of columnList) {
        const next = toSnake(orig);
        if (next === orig) {
          skipped++;
          continue;
        }
        if (finalNames.has(next)) {
          console.warn(
            `COLLISION in "${table}": "${orig}" -> "${next}" conflicts. Skipping.`,
          );
          collisions++;
          continue;
        }
        finalNames.add(next);
        renames.push({ table, from: orig, to: next });
      }
    }

    console.log(`\nTables scanned:    ${byTable.size}`);
    console.log(`Columns scanned:   ${cols.length}`);
    console.log(`To rename:         ${renames.length}`);
    console.log(`Already snake:     ${skipped}`);
    console.log(`Collisions:        ${collisions}\n`);

    if (renames.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    if (dryRun) {
      for (const r of renames)
        console.log(`  "${r.table}"."${r.from}" -> "${r.to}"`);
      console.log("\n(dry run — no changes applied)");
      return;
    }

    await client.query("BEGIN");
    try {
      let done = 0;
      for (const r of renames) {
        await client.query(
          `ALTER TABLE "${r.table}" RENAME COLUMN "${r.from}" TO "${r.to}"`,
        );
        done++;
        if (done % 100 === 0) console.log(`  ${done}/${renames.length}...`);
      }
      await client.query("COMMIT");
      console.log(`\nDone. ${renames.length} columns renamed.`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});

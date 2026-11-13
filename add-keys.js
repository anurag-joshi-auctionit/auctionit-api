import sql from "mssql";
import pg from "pg";

const mssqlConfig = {
  user: "jauction",
  password: "JA@Jindal@123",
  server: "192.168.17.160",
  database: "AuctionIt_testing",
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

const pgConfig = {
  user: "postgres",
  password: "postgres",
  host: "localhost",
  database: "auctionit",
  port: 5432,
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
  const skipFk = process.argv.includes("--no-fk");
  const skipPk = process.argv.includes("--no-pk");

  const mssqlPool = await sql.connect(mssqlConfig);
  const pgClient = new pg.Client(pgConfig);
  await pgClient.connect();

  try {
    const { rows: pgColRows } = await pgClient.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);
    const tableCols = new Map();
    for (const r of pgColRows) {
      if (!tableCols.has(r.table_name)) tableCols.set(r.table_name, new Map());
      tableCols.get(r.table_name).set(toSnake(r.column_name), r.column_name);
    }

    const resolveTable = (t) =>
      tableCols.has(t.toLowerCase()) ? t.toLowerCase() : null;
    const resolveCol = (t, c) => {
      const pgT = resolveTable(t);
      if (!pgT) return null;
      return tableCols.get(pgT).get(toSnake(c)) ?? null;
    };

    if (!skipPk) {
      console.log("\nFetching primary keys from MSSQL...");
      const { recordset: pkRows } = await mssqlPool.request().query(`
        SELECT
          tc.TABLE_NAME, tc.CONSTRAINT_NAME,
          kcu.COLUMN_NAME, kcu.ORDINAL_POSITION
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
         AND kcu.TABLE_SCHEMA   = tc.TABLE_SCHEMA
         AND kcu.TABLE_NAME     = tc.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND tc.TABLE_SCHEMA = 'dbo'
        ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
      `);

      const pks = new Map();
      for (const r of pkRows) {
        const key = `${r.TABLE_NAME}|${r.CONSTRAINT_NAME}`;
        if (!pks.has(key)) pks.set(key, { table: r.TABLE_NAME, cols: [] });
        pks.get(key).cols.push(r.COLUMN_NAME);
      }

      let added = 0,
        skipped = 0,
        failed = 0;
      for (const { table, cols } of pks.values()) {
        const pgT = resolveTable(table);
        if (!pgT) {
          skipped++;
          console.warn(`  skip PK on "${table}": table not in Postgres`);
          continue;
        }
        const pgColNames = cols.map((c) => resolveCol(table, c));
        if (pgColNames.some((c) => c == null)) {
          skipped++;
          console.warn(
            `  skip PK on "${pgT}": cannot resolve columns ${cols.join(", ")}`,
          );
          continue;
        }
        const stmt = `ALTER TABLE "${pgT}" ADD PRIMARY KEY (${pgColNames.map((c) => `"${c}"`).join(", ")})`;
        if (dryRun) {
          console.log("  " + stmt);
          added++;
          continue;
        }
        try {
          await pgClient.query(stmt);
          added++;
        } catch (e) {
          failed++;
          console.warn(
            `  PK failed on "${pgT}" (${cols.join(",")}): ${e.message}`,
          );
        }
      }
      console.log(
        `Primary keys: added=${added} skipped=${skipped} failed=${failed}`,
      );
    }

    if (!skipFk) {
      console.log("\nFetching foreign keys from MSSQL...");
      const { recordset: fkRows } = await mssqlPool.request().query(`
        SELECT
          fk.name                              AS fk_name,
          OBJECT_NAME(fk.parent_object_id)     AS parent_table,
          cp.name                              AS parent_column,
          OBJECT_NAME(fk.referenced_object_id) AS ref_table,
          cr.name                              AS ref_column,
          fkc.constraint_column_id             AS ordinal
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.columns cp ON cp.object_id = fk.parent_object_id     AND cp.column_id = fkc.parent_column_id
        JOIN sys.columns cr ON cr.object_id = fk.referenced_object_id AND cr.column_id = fkc.referenced_column_id
        WHERE SCHEMA_NAME(fk.schema_id) = 'dbo'
        ORDER BY fk.name, ordinal
      `);

      const fks = new Map();
      for (const r of fkRows) {
        if (!fks.has(r.fk_name)) {
          fks.set(r.fk_name, {
            name: r.fk_name,
            parent: r.parent_table,
            ref: r.ref_table,
            parentCols: [],
            refCols: [],
          });
        }
        const f = fks.get(r.fk_name);
        f.parentCols.push(r.parent_column);
        f.refCols.push(r.ref_column);
      }

      let added = 0,
        skipped = 0,
        failed = 0;
      for (const fk of fks.values()) {
        const pgParent = resolveTable(fk.parent);
        const pgRef = resolveTable(fk.ref);
        if (!pgParent || !pgRef) {
          skipped++;
          console.warn(
            `  skip FK ${fk.name}: missing table (${fk.parent} -> ${fk.ref})`,
          );
          continue;
        }
        const pgParentCols = fk.parentCols.map((c) => resolveCol(fk.parent, c));
        const pgRefCols = fk.refCols.map((c) => resolveCol(fk.ref, c));
        if (pgParentCols.some((c) => !c) || pgRefCols.some((c) => !c)) {
          skipped++;
          console.warn(`  skip FK ${fk.name}: missing column(s)`);
          continue;
        }
        const constraintName = toSnake(fk.name).slice(0, 63);
        const stmt =
          `ALTER TABLE "${pgParent}" ADD CONSTRAINT "${constraintName}" ` +
          `FOREIGN KEY (${pgParentCols.map((c) => `"${c}"`).join(", ")}) ` +
          `REFERENCES "${pgRef}" (${pgRefCols.map((c) => `"${c}"`).join(", ")})`;
        if (dryRun) {
          console.log("  " + stmt);
          added++;
          continue;
        }
        try {
          await pgClient.query(stmt);
          added++;
        } catch (e) {
          failed++;
          console.warn(`  FK ${fk.name} failed: ${e.message}`);
        }
      }
      console.log(
        `Foreign keys: added=${added} skipped=${skipped} failed=${failed}`,
      );
    }
  } finally {
    await sql.close();
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});

// Custom MSSQL → Drizzle schema introspector.
// Bypasses drizzle-kit pull beta bugs (view parser, schema-wide duplicate-index check).
// Reads only BASE TABLEs, emits one schema/_pulled.ts with mssqlTable definitions.

import "dotenv/config";
import sql from "mssql";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  server: process.env.MSSQL_SERVER,
  port: Number(process.env.MSSQL_PORT ?? 1433),
  database: process.env.MSSQL_DATABASE,
  options: {
    encrypt: process.env.MSSQL_ENCRYPT === "true",
    trustServerCertificate:
      (process.env.MSSQL_TRUST_SERVER_CERTIFICATE ?? "true") === "true",
  },
};

function toCamel(name) {
  // Normalize anything non-alphanumeric to underscore (spaces, hyphens, etc.).
  const normalized = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (normalized.includes("_")) {
    const parts = normalized.split("_").filter(Boolean).map((s) => s.toLowerCase());
    return parts
      .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
      .join("");
  }
  // Treat consecutive UPPER as one word, so LotID → lotId, ID → id, CLID → clid.
  const withUnders = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  const parts = withUnders.split("_").filter(Boolean).map((s) => s.toLowerCase());
  return parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

function isReservedJs(name) {
  return ["default", "class", "function", "return", "new", "delete"].includes(
    name,
  );
}

function safeIdent(name) {
  const cam = toCamel(name);
  if (isReservedJs(cam) || /^\d/.test(cam)) return `_${cam}`;
  return cam;
}

const USED_TYPES = new Set();
function use(t) {
  USED_TYPES.add(t);
  return t;
}

function colExpression(col, dbName) {
  const t = col.DATA_TYPE.toLowerCase();
  const len = col.CHARACTER_MAXIMUM_LENGTH;
  const p = col.NUMERIC_PRECISION;
  const s = col.NUMERIC_SCALE;
  const nameArg = `"${dbName}"`;

  switch (t) {
    case "int":
      return `${use("int")}(${nameArg})`;
    case "bigint":
      return `${use("bigint")}(${nameArg}, { mode: "number" })`;
    case "smallint":
      return `${use("smallint")}(${nameArg})`;
    case "tinyint":
      return `${use("tinyint")}(${nameArg})`;
    case "bit":
      return `${use("bit")}(${nameArg})`;
    case "decimal":
    case "numeric":
      return `${use("decimal")}(${nameArg}, { precision: ${p ?? 18}, scale: ${s ?? 0} })`;
    case "money":
      return `${use("decimal")}(${nameArg}, { precision: 19, scale: 4 })`;
    case "smallmoney":
      return `${use("decimal")}(${nameArg}, { precision: 10, scale: 4 })`;
    case "float":
      return `${use("float")}(${nameArg})`;
    case "real":
      return `${use("real")}(${nameArg})`;
    case "char":
      return `${use("char")}(${nameArg}, { length: ${len ?? 1} })`;
    case "nchar":
      return `${use("nchar")}(${nameArg}, { length: ${len ?? 1} })`;
    case "varchar":
      return `${use("varchar")}(${nameArg}, { length: ${len === -1 || len == null ? `"max"` : len} })`;
    case "nvarchar":
      return `${use("nvarchar")}(${nameArg}, { length: ${len === -1 || len == null ? `"max"` : len} })`;
    case "text":
      return `${use("text")}(${nameArg})`;
    case "ntext":
      return `${use("ntext")}(${nameArg})`;
    case "date":
      return `${use("date")}(${nameArg}, { mode: "string" })`;
    case "datetime":
      return `${use("datetime")}(${nameArg}, { mode: "string" })`;
    case "datetime2":
      return `${use("datetime2")}(${nameArg}, { mode: "string" })`;
    case "datetimeoffset":
      return `${use("datetimeoffset")}(${nameArg}, { mode: "string" })`;
    case "smalldatetime":
      return `${use("datetime")}(${nameArg}, { mode: "string" })`;
    case "time":
      return `${use("time")}(${nameArg}, { mode: "string" })`;
    case "binary":
      return `${use("binary")}(${nameArg}, { length: ${len ?? 1} })`;
    case "varbinary":
      return `${use("varbinary")}(${nameArg}, { length: ${len === -1 || len == null ? `"max"` : len} })`;
    case "image":
      return `${use("varbinary")}(${nameArg}, { length: "max" })`;
    default:
      return `${use("customType")}<{ data: unknown }>({ dataType: () => "${t}" })(${nameArg})`;
  }
}

function defaultExpression(raw, dataType) {
  if (raw == null) return null;
  let s = String(raw).trim();
  while (s.startsWith("(") && s.endsWith(")")) {
    const inner = s.slice(1, -1).trim();
    let depth = 0;
    let balanced = true;
    for (const ch of inner) {
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth < 0) {
          balanced = false;
          break;
        }
      }
    }
    if (!balanced || depth !== 0) break;
    s = inner;
  }
  const t = dataType.toLowerCase();
  if (/^getdate\s*\(\s*\)$/i.test(s) || /^getutcdate\s*\(\s*\)$/i.test(s) || /^sysutcdatetime\s*\(\s*\)$/i.test(s) || /^sysdatetime\s*\(\s*\)$/i.test(s)) {
    return `.default(${use("sql")}\`${s}\`)`;
  }
  if (/^newid\s*\(\s*\)$/i.test(s)) {
    return `.default(${use("sql")}\`${s}\`)`;
  }
  if (s.toUpperCase() === "NULL") return null;
  if (s.startsWith("'") && s.endsWith("'")) {
    return `.default(${s})`;
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    if (t === "bit") return `.default(${s === "1" ? "true" : "false"})`;
    return `.default(${s})`;
  }
  return `.default(${use("sql")}\`${s}\`)`;
}

async function main() {
  console.log("Connecting to MSSQL…");
  const pool = await sql.connect(config);

  const tables = (await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = 'dbo'
    ORDER BY TABLE_NAME
  `)).recordset.map((r) => r.TABLE_NAME).filter((n) => n !== "sysdiagrams");

  console.log(`Found ${tables.length} base tables.`);

  const cols = (await pool.request().query(`
    SELECT
      TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, IS_NULLABLE,
      DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
      COLUMN_DEFAULT
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `)).recordset;

  const pks = (await pool.request().query(`
    SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
    WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = 'dbo'
    ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION
  `)).recordset;

  const identityCols = (await pool.request().query(`
    SELECT OBJECT_NAME(c.object_id) AS table_name, c.name AS column_name
    FROM sys.columns c
    INNER JOIN sys.objects o ON o.object_id = c.object_id
    WHERE o.type = 'U' AND SCHEMA_NAME(o.schema_id) = 'dbo' AND c.is_identity = 1
  `)).recordset;

  await pool.close();

  const tableSet = new Set(tables);

  const colsByTable = new Map();
  for (const c of cols) {
    if (!tableSet.has(c.TABLE_NAME)) continue;
    if (!colsByTable.has(c.TABLE_NAME)) colsByTable.set(c.TABLE_NAME, []);
    colsByTable.get(c.TABLE_NAME).push(c);
  }

  const pksByTable = new Map();
  for (const pk of pks) {
    if (!tableSet.has(pk.TABLE_NAME)) continue;
    if (!pksByTable.has(pk.TABLE_NAME)) pksByTable.set(pk.TABLE_NAME, []);
    pksByTable.get(pk.TABLE_NAME).push(pk.COLUMN_NAME);
  }

  const identityByTable = new Map();
  for (const id of identityCols) {
    if (!tableSet.has(id.table_name)) continue;
    if (!identityByTable.has(id.table_name)) identityByTable.set(id.table_name, new Set());
    identityByTable.get(id.table_name).add(id.column_name);
  }

  const lines = [];

  for (const table of tables) {
    const columnRows = colsByTable.get(table) ?? [];
    const pkCols = pksByTable.get(table) ?? [];
    const identitySet = identityByTable.get(table) ?? new Set();
    const tableVar = safeIdent(table);

    lines.push(`export const ${tableVar} = ${use("mssqlTable")}("${table}", {`);
    for (const col of columnRows) {
      const fieldName = safeIdent(col.COLUMN_NAME);
      let expr = colExpression(col, col.COLUMN_NAME);
      if (identitySet.has(col.COLUMN_NAME)) expr += `.identity()`;
      const def = defaultExpression(col.COLUMN_DEFAULT, col.DATA_TYPE);
      if (def) expr += def;
      if (col.IS_NULLABLE === "NO" && !pkCols.includes(col.COLUMN_NAME))
        expr += `.notNull()`;
      if (pkCols.length === 1 && pkCols[0] === col.COLUMN_NAME)
        expr += `.primaryKey()`;
      lines.push(`  ${fieldName}: ${expr},`);
    }
    if (pkCols.length > 1) {
      const cols = pkCols.map((c) => `t.${safeIdent(c)}`).join(", ");
      lines.push(`}, (t) => [${use("primaryKey")}({ columns: [${cols}] })]);`);
    } else {
      lines.push(`});`);
    }
    lines.push("");
  }

  const importNames = [...USED_TYPES].filter((n) => n !== "sql" && n !== "customType").sort();
  const importDrizzleOrm = [];
  if (USED_TYPES.has("sql")) importDrizzleOrm.push("sql");

  const header = [];
  if (importDrizzleOrm.length > 0) {
    header.push(`import { ${importDrizzleOrm.join(", ")} } from "drizzle-orm";`);
  }
  const mssqlImports = importNames.slice();
  if (USED_TYPES.has("customType")) mssqlImports.push("customType");
  mssqlImports.sort();
  header.push(`import { ${mssqlImports.join(", ")} } from "drizzle-orm/mssql-core";`);
  header.push("");

  const outFile = path.join(__dirname, "src", "db", "schema", "_pulled.ts");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, header.concat(lines).join("\n"));
  console.log(`Wrote ${outFile} with ${tables.length} tables.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

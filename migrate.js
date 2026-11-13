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

const BATCH_SIZE = 500;

function mssqlTypeToPg(col) {
  const type = col.DATA_TYPE.toLowerCase();
  const len = col.CHARACTER_MAXIMUM_LENGTH;
  const precision = col.NUMERIC_PRECISION;
  const scale = col.NUMERIC_SCALE;

  switch (type) {
    case "int":
      return "integer";
    case "bigint":
      return "bigint";
    case "smallint":
      return "smallint";
    case "tinyint":
      return "smallint";
    case "bit":
      return "boolean";
    case "decimal":
    case "numeric":
      return `numeric(${precision ?? 18},${scale ?? 0})`;
    case "float":
      return "double precision";
    case "real":
      return "real";
    case "money":
      return "numeric(19,4)";
    case "smallmoney":
      return "numeric(10,4)";
    case "varchar":
    case "nvarchar":
      return len === -1 || len == null ? "text" : `varchar(${len})`;
    case "char":
    case "nchar":
      return `char(${len})`;
    case "text":
    case "ntext":
      return "text";
    case "datetime":
    case "datetime2":
    case "smalldatetime":
      return "timestamp";
    case "datetimeoffset":
      return "timestamptz";
    case "date":
      return "date";
    case "time":
      return "time";
    case "uniqueidentifier":
      return "uuid";
    case "varbinary":
    case "binary":
    case "image":
      return "bytea";
    case "xml":
      return "text";
    default:
      return "text";
  }
}

async function migrateTables() {
  console.log("Connecting to MSSQL...");
  const mssqlPool = await sql.connect(mssqlConfig);

  console.log("Connecting to PostgreSQL...");
  const pgClient = new pg.Client(pgConfig);
  await pgClient.connect();

  try {
    console.log("Cleaning up PostgreSQL database...");
    await pgClient.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await pgClient.query(
      `GRANT ALL ON SCHEMA public TO "${pgConfig.user}"; GRANT ALL ON SCHEMA public TO public;`,
    );

    const tablesResult = await mssqlPool.request().query(`
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = 'dbo'
      ORDER BY TABLE_NAME
    `);
    const tables = tablesResult.recordset.map((r) => r.TABLE_NAME);
    console.log(`\nFound ${tables.length} tables.\n`);

    for (const table of tables) {
      process.stdout.write(`  [${table}] ... `);

      const colsResult = await mssqlPool.request().query(`
        SELECT
          c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH,
          c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.IS_NULLABLE,
          COLUMNPROPERTY(OBJECT_ID('dbo.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
        FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_NAME = '${table}' AND c.TABLE_SCHEMA = 'dbo'
        ORDER BY c.ORDINAL_POSITION
      `);
      const columns = colsResult.recordset;

      const colDefs = columns
        .map((col) => {
          const pgType = mssqlTypeToPg(col);
          const nullable = col.IS_NULLABLE === "YES" ? "" : " NOT NULL";
          return `  "${col.COLUMN_NAME}" ${pgType}${nullable}`;
        })
        .join(",\n");

      const pgTable = table.toLowerCase();
      await pgClient.query(`DROP TABLE IF EXISTS "${pgTable}" CASCADE`);
      await pgClient.query(`CREATE TABLE "${pgTable}" (\n${colDefs}\n)`);

      const colNames = columns.map((c) => `"${c.COLUMN_NAME}"`).join(", ");
      let totalRows = 0;
      let buffer = [];

      const flushBuffer = async () => {
        if (buffer.length === 0) return;
        const values = [];
        const placeholders = buffer
          .map(
            (row, ri) =>
              "(" +
              columns
                .map((col, ci) => {
                  let val = row[col.COLUMN_NAME] ?? null;
                  if (
                    col.DATA_TYPE.toLowerCase() === "uniqueidentifier" &&
                    val != null
                  ) {
                    val = val.toLowerCase();
                  }
                  values.push(val);
                  return `$${ri * columns.length + ci + 1}`;
                })
                .join(", ") +
              ")",
          )
          .join(", ");
        await pgClient.query(
          `INSERT INTO "${pgTable}" (${colNames}) VALUES ${placeholders}`,
          values,
        );
        buffer = [];
      };

      await new Promise((resolve, reject) => {
        const request = mssqlPool.request();
        request.stream = true;
        request.query(`SELECT * FROM [dbo].[${table}]`);

        request.on("row", (row) => {
          buffer.push(row);
          totalRows++;
          if (buffer.length >= BATCH_SIZE) {
            request.pause();
            flushBuffer()
              .then(() => request.resume())
              .catch(reject);
          }
        });

        request.on("error", reject);
        request.on("done", () => flushBuffer().then(resolve).catch(reject));
      });

      console.log(`${totalRows} rows`);
    }

    console.log("\nMigration complete.");
  } finally {
    await sql.close();
    await pgClient.end();
  }
}

migrateTables().catch((err) => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});

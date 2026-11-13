import pg from "pg";
import { env } from "../../env.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { connectMssql } from "./mssql.js";

// Subscription payment mode catalog from legacy tbl_Config_PaymentType.
const SOURCE_SQL = `
SELECT
  id                    AS id,
  PaymentTypeName       AS name,
  IsActive              AS isActive
FROM tbl_Config_PaymentType
ORDER BY id
`;

const UPSERT_SQL = `
INSERT INTO payment_types (id, name, is_active, created_at, created_by)
VALUES ($1, $2, $3, NOW(), $4)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  is_active = EXCLUDED.is_active,
  updated_at = NOW(),
  updated_by = $4,
  created_by = COALESCE(payment_types.created_by, EXCLUDED.created_by)
`;

type SourceRow = {
  id: number;
  name: string | null;
  isActive: boolean | number | null;
};

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(`Pulled ${result.recordset.length} payment type rows from MSSQL.`);
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const client = await pgPool.connect();
    let upserted = 0;
    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        await client.query(UPSERT_SQL, [
          r.id,
          r.name?.trim() || `Payment ${r.id}`,
          r.isActive === true || r.isActive === 1,
          SEED_DEFAULT_USER_ID,
        ]);
        upserted++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(`Upserted ${upserted} payment types in ${Date.now() - started}ms.`);
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

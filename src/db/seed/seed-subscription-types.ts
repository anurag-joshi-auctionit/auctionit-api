import pg from "pg";
import { env } from "../../env.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { connectMssql } from "./mssql.js";

// Subscription plan catalog, migrated from legacy tbl_Config_SubscriptionType
// (e.g. Annual, LifeTime). Months 0/NULL → seed as 1200 (10 years).
const SOURCE_SQL = `
SELECT
  Id                                    AS id,
  SubscriptionType                      AS name,
  Amount                                AS amount,
  GSTPer                                AS gstPercent,
  Months                                AS months,
  IsActive                              AS isActive,
  CONVERT(varchar(33), InsertDate, 126) AS createdAt
FROM tbl_Config_SubscriptionType
ORDER BY Id
`;

const UPSERT_SQL = `
INSERT INTO subscription_types (
  id, name, amount, gst_percent, months, is_active, created_at, created_by
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  amount = EXCLUDED.amount,
  gst_percent = EXCLUDED.gst_percent,
  months = EXCLUDED.months,
  is_active = EXCLUDED.is_active,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by
`;

type SourceRow = {
  id: number;
  name: string | null;
  amount: string | number | null;
  gstPercent: string | number | null;
  months: number | null;
  isActive: boolean | number | null;
  createdAt: string | null;
};

function numericOrZero(v: string | number | null | undefined): string {
  if (v == null) return "0";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "0";
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} subscription type rows from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const client = await pgPool.connect();
    let upserted = 0;
    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        const months =
          r.months && r.months > 0 ? r.months : 1200;
        await client.query(UPSERT_SQL, [
          r.id,
          r.name?.trim() || `Subscription ${r.id}`,
          numericOrZero(r.amount),
          numericOrZero(r.gstPercent),
          months,
          r.isActive === true || r.isActive === 1,
          r.createdAt ?? new Date().toISOString(),
          SEED_DEFAULT_USER_ID,
        ]);
        upserted++;
      }
      // Legacy PaymentTransaction / OnlinePaymentRequestLog often use NULL/0
      // for SubscriptionTypeId — keep 0 as a non-meaningful placeholder FK.
      await client.query(
        `INSERT INTO subscription_types (
           id, name, amount, gst_percent, months, is_active, created_at, created_by
         ) VALUES (0, 'Unknown', 0, 0, 0, false, NOW(), $1)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           is_active = false,
           created_by = EXCLUDED.created_by`,
        [SEED_DEFAULT_USER_ID],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Upserted ${upserted} subscription types in ${Date.now() - started}ms.`,
    );
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

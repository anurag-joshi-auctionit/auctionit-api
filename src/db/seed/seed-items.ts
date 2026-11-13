import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import { asString } from "./resolve-location-id.js";

const SOURCE_SQL = `
SELECT
  im.ItemId                         AS itemId,
  im.ClientId                       AS clientId,
  im.IsActive                       AS isActive,
  im.ItemDescription                AS itemDescription,
  bm.MeterialName                   AS benchmarkMaterialName,
  CONVERT(varchar(33), im.CreateDatetime, 126) AS createdAt,
  im.CreatedBy                      AS createdBy,
  CONVERT(varchar(33), im.UpdateDatetime, 126) AS updatedAt,
  im.UpdatedBy                      AS updatedBy
FROM tbl_Config_ItemMst im
LEFT JOIN tbl_Config_BenchMarkMeterialMst bm ON bm.MaterialId = im.MaterialId
`;

const BENCHMARK_MATERIAL_UPSERT_SQL = `
INSERT INTO benchmark_materials (name, is_active, created_at, created_by, updated_at, updated_by)
VALUES ($1, true, now(), $2, now(), $2)
ON CONFLICT (lower(name)) DO NOTHING
`;

const UPSERT_SQL = `
INSERT INTO items (
  id, client_id, name, is_active, material_id, benchmark_material_id, uom_id,
  created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, NULL, $5, NULL,
  $6, $7, $8, $9
)
ON CONFLICT (id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  name = EXCLUDED.name,
  is_active = EXCLUDED.is_active,
  benchmark_material_id = COALESCE(items.benchmark_material_id, EXCLUDED.benchmark_material_id),
  uom_id = EXCLUDED.uom_id,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
  itemId: number;
  clientId: number | null;
  isActive: boolean;
  itemDescription: string | null;
  benchmarkMaterialName: string | null;
  createdAt: string;
  createdBy: number;
  updatedAt: string | null;
  updatedBy: number | null;
};

async function loadClientIds(pool: pg.Pool): Promise<Set<number>> {
  const res = await pool.query<{ id: number }>("SELECT id FROM clients");
  return new Set(res.rows.map((r) => r.id));
}

async function loadUserIds(pool: pg.Pool): Promise<Set<number>> {
  const res = await pool.query<{ id: number }>("SELECT id FROM users");
  return new Set(res.rows.map((r) => r.id));
}

/** Upserts any benchmark material names not already present, then returns a lower(name) -> id map. */
async function resolveBenchmarkMaterialIds(
  client: pg.PoolClient,
  names: string[],
  userId: number,
): Promise<Map<string, number>> {
  const distinct = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  for (const name of distinct) {
    await client.query(BENCHMARK_MATERIAL_UPSERT_SQL, [name, userId]);
  }

  const res = await client.query<{ id: number; name: string }>(
    "SELECT id, name FROM benchmark_materials",
  );
  const map = new Map<string, number>();
  for (const row of res.rows) {
    map.set(row.name.trim().toLowerCase(), row.id);
  }
  return map;
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(`Pulled ${result.recordset.length} item rows from MSSQL.`);
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [clientIds, userIds] = await Promise.all([
      loadClientIds(pgPool),
      loadUserIds(pgPool),
    ]);
    userIds.add(SEED_DEFAULT_USER_ID);

    const client = await pgPool.connect();
    let upserted = 0;
    let skippedClient = 0;
    let defaultedCreatedBy = 0;
    let benchmarkMaterialsMatched = 0;

    try {
      await client.query("BEGIN");

      const benchmarkMaterialMap = await resolveBenchmarkMaterialIds(
        client,
        result.recordset
          .map((r) => r.benchmarkMaterialName)
          .filter((n): n is string => Boolean(n && n.trim())),
        SEED_DEFAULT_USER_ID,
      );

      for (const r of result.recordset) {
        if (r.clientId == null || !clientIds.has(r.clientId)) {
          skippedClient++;
          continue;
        }

        const createdBy = resolveAuditUserId(r.createdBy, userIds);
        if (r.createdBy !== createdBy) defaultedCreatedBy++;

        const benchmarkMaterialId = r.benchmarkMaterialName
          ? (benchmarkMaterialMap.get(r.benchmarkMaterialName.trim().toLowerCase()) ?? null)
          : null;
        if (benchmarkMaterialId != null) benchmarkMaterialsMatched++;

        await client.query(UPSERT_SQL, [
          r.itemId,
          r.clientId,
          asString(r.itemDescription),
          Boolean(r.isActive),
          benchmarkMaterialId,
          r.createdAt,
          createdBy,
          r.updatedAt,
          resolveAuditUserIdIfTimestamp(r.updatedAt, r.updatedBy, userIds),
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

    console.log(
      `Upserted ${upserted} rows into items (material_id left NULL; ` +
        `benchmark_material_id matched on ${benchmarkMaterialsMatched} rows, ` +
        `filled only where previously unset) ` +
        `(${skippedClient} skipped missing client, ` +
        `defaulted created_by to 1 on ${defaultedCreatedBy} rows) ` +
        `in ${Date.now() - started}ms.`,
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

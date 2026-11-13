import { sql } from "drizzle-orm";
import pg from "pg";
import { env } from "../../env.js";
import { db, pool as drizzlePool } from "../index.js";
import type { BenchmarkCurrency } from "../schema/benchmark-material-locations.js";
import {
  nonInrPriceDateRange,
  rateBenchmarkPrices,
} from "../../services/benchmark-price-rating.js";
import { fxRatesService } from "../../services/fx-rates.service.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import { asString } from "./resolve-location-id.js";

const COMBOS_SOURCE_SQL = `
SELECT DISTINCT
  m.MeterialName AS material,
  l.LocationName AS location,
  CASE WHEN m.IsActive = 1 AND l.IsActive = 1 THEN 1 ELSE 0 END AS isActive,
  CONVERT(varchar(33), map.CreatedOn, 126) AS createdAt,
  map.CreatedBy AS createdBy,
  CONVERT(varchar(33), map.UpdatedOn, 126) AS updatedAt,
  map.UpdatedBy AS updatedBy
FROM tbl_Config_MeterialLocationMap map
INNER JOIN tbl_Config_BenchMarkMeterialMst m ON map.MaterialId = m.MaterialId
INNER JOIN tbl_Config_BenchMarkLocation l ON map.LocationId = l.LocationId
`;

const PRICES_SOURCE_SQL = `
SELECT
  m.MeterialName AS material,
  l.LocationName AS location,
  CONVERT(varchar(10), bp.BenchMarkDate, 23) AS benchmarkDate,
  bp.Price AS price,
  CONVERT(varchar(33), bp.CreatedOn, 126) AS createdAt,
  bp.CreatedBy AS createdBy,
  CONVERT(varchar(33), bp.UpdatedOn, 126) AS updatedAt,
  bp.UpdatedBy AS updatedBy
FROM tbl_Data_BenchMarkMeterials bp
INNER JOIN tbl_Config_BenchMarkMeterialMst m ON bp.MaterialId = m.MaterialId
INNER JOIN tbl_Config_BenchMarkLocation l ON bp.LocationId = l.LocationId
WHERE bp.IsActive = 1
`;

const MATERIAL_UPSERT_SQL = `
INSERT INTO benchmark_materials (name, is_active, created_at, created_by, updated_at, updated_by)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (lower(name)) DO UPDATE SET
  is_active = EXCLUDED.is_active OR benchmark_materials.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
RETURNING id
`;

const LOCATION_UPSERT_SQL = `
INSERT INTO benchmark_locations (name, is_active, created_at, created_by, updated_at, updated_by)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (lower(name)) DO UPDATE SET
  is_active = EXCLUDED.is_active OR benchmark_locations.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
RETURNING id
`;

const COMBO_UPSERT_SQL = `
INSERT INTO benchmark_material_locations (
  material_id, location_id, is_active, created_at, created_by, updated_at, updated_by, currency
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (material_id, location_id) DO UPDATE SET
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
RETURNING id
`;

const PRICE_UPSERT_SQL = `
INSERT INTO benchmark_prices (
  benchmark_material_location_id, benchmark_date, price, price_inr,
  created_at, created_by, updated_at, updated_by
) VALUES ($1, $2, $3, $3, $4, $5, $6, $7)
ON CONFLICT (benchmark_material_location_id, benchmark_date) DO UPDATE SET
  price = EXCLUDED.price,
  price_inr = EXCLUDED.price_inr,
  currency = EXCLUDED.currency,
  exchange_rate = EXCLUDED.exchange_rate,
  rate_date = EXCLUDED.rate_date,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type ComboSourceRow = {
  material: string;
  location: string;
  isActive: boolean;
  createdAt: string;
  createdBy: number;
  updatedAt: string | null;
  updatedBy: number | null;
};

type PriceSourceRow = {
  material: string;
  location: string;
  benchmarkDate: string;
  price: number;
  createdAt: string;
  createdBy: number;
  updatedAt: string | null;
  updatedBy: number | null;
};

/** Legacy data marks USD-quoted locations with a `$` suffix (e.g. `LME$`). */
function currencyForLocation(location: string): BenchmarkCurrency {
  return location.includes("$") ? "USD" : "INR";
}

async function loadUserIds(pool: pg.Pool): Promise<Set<number>> {
  const res = await pool.query<{ id: number }>("SELECT id FROM users");
  return new Set(res.rows.map((r) => r.id));
}

async function upsertMaterial(
  client: pg.PoolClient,
  name: string,
  isActive: boolean,
  createdAt: string,
  createdBy: number,
  updatedAt: string | null,
  updatedBy: number | null,
): Promise<number> {
  const result = await client.query<{ id: number }>(MATERIAL_UPSERT_SQL, [
    name,
    isActive,
    createdAt,
    createdBy,
    updatedAt,
    updatedBy,
  ]);
  return result.rows[0]!.id;
}

async function upsertLocation(
  client: pg.PoolClient,
  name: string,
  isActive: boolean,
  createdAt: string,
  createdBy: number,
  updatedAt: string | null,
  updatedBy: number | null,
): Promise<number> {
  const result = await client.query<{ id: number }>(LOCATION_UPSERT_SQL, [
    name,
    isActive,
    createdAt,
    createdBy,
    updatedAt,
    updatedBy,
  ]);
  return result.rows[0]!.id;
}

async function upsertCombo(
  client: pg.PoolClient,
  row: {
    material: string;
    location: string;
    isActive: boolean;
    createdAt: string;
    createdBy: number;
    updatedAt: string | null;
    updatedBy: number | null;
  },
): Promise<number> {
  const material = row.material.trim();
  const location = row.location.trim();
  const materialId = await upsertMaterial(
    client,
    material,
    row.isActive,
    row.createdAt,
    row.createdBy,
    row.updatedAt,
    row.updatedBy,
  );
  const locationId = await upsertLocation(
    client,
    location,
    row.isActive,
    row.createdAt,
    row.createdBy,
    row.updatedAt,
    row.updatedBy,
  );
  const result = await client.query<{ id: number }>(COMBO_UPSERT_SQL, [
    materialId,
    locationId,
    row.isActive,
    row.createdAt,
    row.createdBy,
    row.updatedAt,
    row.updatedBy,
    currencyForLocation(location),
  ]);
  return result.rows[0]!.id;
}

async function rateSeededPrices() {
  for (const range of await nonInrPriceDateRange()) {
    const today = new Date().toISOString().slice(0, 10);
    const to = range.to > today ? today : range.to;
    const loaded = await fxRatesService.loadRange(range.currency, range.from, to);
    console.log(`Loaded ${loaded} ${range.currency}/INR rate(s) for ${range.from}..${to}.`);
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`);
    return rateBenchmarkPrices({}, tx);
  });
  console.log(
    `Rated benchmark prices: ${result.inrRows} INR, ${result.convertedRows} converted, ` +
      `${result.unratedRows} unrated.`,
  );
}

async function loadComboIdMap(client: pg.PoolClient): Promise<Map<string, number>> {
  const res = await client.query<{ id: number; material: string; location: string }>(
    `SELECT bml.id, bm.name AS material, bl.name AS location
     FROM benchmark_material_locations bml
     JOIN benchmark_materials bm ON bm.id = bml.material_id
     JOIN benchmark_locations bl ON bl.id = bml.location_id`,
  );
  const map = new Map<string, number>();
  for (const row of res.rows) {
    map.set(`${row.material.trim()}|${row.location.trim()}`, row.id);
  }
  return map;
}

async function seedFromMssql(pgPool: pg.Pool) {
  const mssqlPool = await connectMssql();
  const started = Date.now();

  try {
    const [comboResult, priceResult] = await Promise.all([
      mssqlPool.request().query<ComboSourceRow>(COMBOS_SOURCE_SQL),
      mssqlPool.request().query<PriceSourceRow>(PRICES_SOURCE_SQL),
    ]);

    console.log(
      `Pulled ${comboResult.recordset.length} combo rows and ${priceResult.recordset.length} price rows from MSSQL.`,
    );

    const userIds = await loadUserIds(pgPool);
    userIds.add(SEED_DEFAULT_USER_ID);
    const client = await pgPool.connect();
    let combosUpserted = 0;
    let pricesUpserted = 0;
    let skippedPricesMissingMaterialOrLocation = 0;
    let skippedPricesMissingDate = 0;

    try {
      await client.query("BEGIN");

      for (const row of comboResult.recordset) {
        const material = asString(row.material);
        const location = asString(row.location);
        if (!material || !location) continue;

        await upsertCombo(client, {
          material,
          location,
          isActive: Boolean(row.isActive),
          createdAt: row.createdAt,
          createdBy: resolveAuditUserId(row.createdBy, userIds),
          updatedAt: row.updatedAt,
          updatedBy: resolveAuditUserIdIfTimestamp(
            row.updatedAt,
            row.updatedBy,
            userIds,
          ),
        });
        combosUpserted++;
      }

      const comboIdMap = await loadComboIdMap(client);
      const now = new Date().toISOString();

      for (const row of priceResult.recordset) {
        const material = asString(row.material);
        const location = asString(row.location);
        if (!material || !location) {
          skippedPricesMissingMaterialOrLocation++;
          continue;
        }
        if (!row.benchmarkDate) {
          skippedPricesMissingDate++;
          continue;
        }

        const comboKey = `${material.trim()}|${location.trim()}`;
        let comboId = comboIdMap.get(comboKey);
        if (comboId == null) {
          comboId = await upsertCombo(client, {
            material,
            location,
            isActive: true,
            createdAt: row.createdAt ?? now,
            createdBy: resolveAuditUserId(row.createdBy, userIds),
            updatedAt: row.updatedAt,
            updatedBy: resolveAuditUserIdIfTimestamp(
              row.updatedAt,
              row.updatedBy,
              userIds,
            ),
          });
          comboIdMap.set(comboKey, comboId);
        }

        const priceUpdatedAt = row.updatedAt ?? row.createdAt ?? now;
        await client.query(PRICE_UPSERT_SQL, [
          comboId,
          row.benchmarkDate,
          Number(row.price).toFixed(2),
          row.createdAt ?? now,
          resolveAuditUserId(row.createdBy, userIds),
          priceUpdatedAt,
          resolveAuditUserIdIfTimestamp(
            priceUpdatedAt,
            row.updatedBy,
            userIds,
          ),
        ]);
        pricesUpserted++;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Seeded ${combosUpserted} benchmark combos and ${pricesUpserted} benchmark prices ` +
        `(${skippedPricesMissingMaterialOrLocation} skipped: missing material/location, ` +
        `${skippedPricesMissingDate} skipped: missing benchmark date) ` +
        `in ${Date.now() - started}ms.`,
    );
  } finally {
    await mssqlPool.close();
  }
}

async function main() {
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });
  try {
    await seedFromMssql(pgPool);
    await rateSeededPrices();
  } finally {
    await pgPool.end();
    await drizzlePool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

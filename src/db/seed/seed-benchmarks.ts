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
import { upsertBatched } from "./batch-write.js";
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

// Bulk unnest upserts for catalog tables — returns id + lower(name) for map building
const MATERIAL_BULK_SQL = `
INSERT INTO benchmark_materials (name, is_active, created_at, created_by, updated_at, updated_by)
SELECT unnest($1::text[]), unnest($2::bool[]), unnest($3::text[])::timestamptz, unnest($4::int[]), unnest($5::text[])::timestamptz, unnest($6::int[])
ON CONFLICT (lower(name)) DO UPDATE SET
  is_active = EXCLUDED.is_active OR benchmark_materials.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
RETURNING id, lower(name) AS name_lower
`;

const LOCATION_BULK_SQL = `
INSERT INTO benchmark_locations (name, is_active, created_at, created_by, updated_at, updated_by)
SELECT unnest($1::text[]), unnest($2::bool[]), unnest($3::text[])::timestamptz, unnest($4::int[]), unnest($5::text[])::timestamptz, unnest($6::int[])
ON CONFLICT (lower(name)) DO UPDATE SET
  is_active = EXCLUDED.is_active OR benchmark_locations.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
RETURNING id, lower(name) AS name_lower
`;

// $3 passed twice (price + price_inr) makes 8 params per row
const PRICE_HEAD_SQL = `
INSERT INTO benchmark_prices (
  benchmark_material_location_id, benchmark_date, price, price_inr,
  created_at, created_by, updated_at, updated_by
)`;

const PRICE_TAIL_SQL = `
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

/** Bulk-upsert materials and return a lower(name) → id map. */
async function bulkUpsertMaterials(
  client: pg.PoolClient,
  rows: { name: string; isActive: boolean; createdAt: string; createdBy: number; updatedAt: string | null; updatedBy: number | null }[],
): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const res = await client.query<{ id: number; name_lower: string }>(MATERIAL_BULK_SQL, [
    rows.map((r) => r.name),
    rows.map((r) => r.isActive),
    rows.map((r) => r.createdAt),
    rows.map((r) => r.createdBy),
    rows.map((r) => r.updatedAt),
    rows.map((r) => r.updatedBy),
  ]);
  const map = new Map<string, number>();
  for (const row of res.rows) map.set(row.name_lower, row.id);
  return map;
}

/** Bulk-upsert locations and return a lower(name) → id map. */
async function bulkUpsertLocations(
  client: pg.PoolClient,
  rows: { name: string; isActive: boolean; createdAt: string; createdBy: number; updatedAt: string | null; updatedBy: number | null }[],
): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const res = await client.query<{ id: number; name_lower: string }>(LOCATION_BULK_SQL, [
    rows.map((r) => r.name),
    rows.map((r) => r.isActive),
    rows.map((r) => r.createdAt),
    rows.map((r) => r.createdBy),
    rows.map((r) => r.updatedAt),
    rows.map((r) => r.updatedBy),
  ]);
  const map = new Map<string, number>();
  for (const row of res.rows) map.set(row.name_lower, row.id);
  return map;
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
    const now = new Date().toISOString();

    const client = await pgPool.connect();
    let combosUpserted = 0;
    let skippedPricesMissingMaterialOrLocation = 0;
    let skippedPricesMissingDate = 0;

    try {
      await client.query("BEGIN");

      // ── 1. Collect all distinct materials and locations from both sources ──
      type CatalogEntry = { name: string; isActive: boolean; createdAt: string; createdBy: number; updatedAt: string | null; updatedBy: number | null };
      const materialMap = new Map<string, CatalogEntry>();
      const locationMap = new Map<string, CatalogEntry>();

      const addEntry = (map: Map<string, CatalogEntry>, name: string, entry: CatalogEntry) => {
        const key = name.trim().toLowerCase();
        if (!map.has(key)) map.set(key, { ...entry, name: name.trim() });
      };

      for (const row of comboResult.recordset) {
        const material = asString(row.material);
        const location = asString(row.location);
        if (!material || !location) continue;
        const isActive = Boolean(row.isActive);
        const createdBy = resolveAuditUserId(row.createdBy, userIds);
        const entry: CatalogEntry = { name: material, isActive, createdAt: row.createdAt, createdBy, updatedAt: row.updatedAt, updatedBy: resolveAuditUserIdIfTimestamp(row.updatedAt, row.updatedBy, userIds) };
        addEntry(materialMap, material, entry);
        addEntry(locationMap, location, { ...entry, name: location });
      }

      for (const row of priceResult.recordset) {
        const material = asString(row.material);
        const location = asString(row.location);
        if (!material || !location) continue;
        const createdBy = resolveAuditUserId(row.createdBy, userIds);
        const entry: CatalogEntry = { name: material, isActive: true, createdAt: row.createdAt ?? now, createdBy, updatedAt: row.updatedAt, updatedBy: resolveAuditUserIdIfTimestamp(row.updatedAt, row.updatedBy, userIds) };
        addEntry(materialMap, material, entry);
        addEntry(locationMap, location, { ...entry, name: location });
      }

      // ── 2. Bulk upsert materials and locations, get name→id maps ──
      const materialIdMap = await bulkUpsertMaterials(client, [...materialMap.values()]);
      const locationIdMap = await bulkUpsertLocations(client, [...locationMap.values()]);

      // ── 3. Upsert combos using resolved IDs, build comboKey→id map ──
      for (const row of comboResult.recordset) {
        const material = asString(row.material);
        const location = asString(row.location);
        if (!material || !location) continue;

        const materialId = materialIdMap.get(material.trim().toLowerCase());
        const locationId = locationIdMap.get(location.trim().toLowerCase());
        if (materialId == null || locationId == null) continue;

        await client.query(
          `INSERT INTO benchmark_material_locations (material_id, location_id, is_active, created_at, created_by, updated_at, updated_by, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (material_id, location_id) DO UPDATE SET
             is_active = EXCLUDED.is_active,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
          [
            materialId, locationId, Boolean(row.isActive), row.createdAt,
            resolveAuditUserId(row.createdBy, userIds), row.updatedAt,
            resolveAuditUserIdIfTimestamp(row.updatedAt, row.updatedBy, userIds),
            currencyForLocation(location),
          ],
        );
        combosUpserted++;
      }

      // Reload combo map after all combos are upserted
      const comboIdMap = await loadComboIdMap(client);

      // ── 4. Build price rows in-memory, then bulk upsert ──
      const priceRows: unknown[][] = [];

      for (const row of priceResult.recordset) {
        const material = asString(row.material);
        const location = asString(row.location);
        if (!material || !location) { skippedPricesMissingMaterialOrLocation++; continue; }
        if (!row.benchmarkDate) { skippedPricesMissingDate++; continue; }

        const comboKey = `${material.trim()}|${location.trim()}`;
        let comboId = comboIdMap.get(comboKey);

        if (comboId == null) {
          // Edge case: price references a combo not in the original combos list
          const materialId = materialIdMap.get(material.trim().toLowerCase());
          const locationId = locationIdMap.get(location.trim().toLowerCase());
          if (materialId == null || locationId == null) { skippedPricesMissingMaterialOrLocation++; continue; }
          const res = await client.query<{ id: number }>(
            `INSERT INTO benchmark_material_locations (material_id, location_id, is_active, created_at, created_by, updated_at, updated_by, currency)
             VALUES ($1, $2, true, $3, $4, $5, $6, $7)
             ON CONFLICT (material_id, location_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
             RETURNING id`,
            [materialId, locationId, row.createdAt ?? now, resolveAuditUserId(row.createdBy, userIds), row.updatedAt, resolveAuditUserIdIfTimestamp(row.updatedAt, row.updatedBy, userIds), currencyForLocation(location)],
          );
          comboId = res.rows[0]!.id;
          comboIdMap.set(comboKey, comboId);
        }

        const priceUpdatedAt = row.updatedAt ?? row.createdAt ?? now;
        const priceVal = Number(row.price).toFixed(2);
        priceRows.push([
          comboId,
          row.benchmarkDate,
          priceVal,
          priceVal,  // price_inr (same value; rated by rateSeededPrices() after)
          row.createdAt ?? now,
          resolveAuditUserId(row.createdBy, userIds),
          priceUpdatedAt,
          resolveAuditUserIdIfTimestamp(priceUpdatedAt, row.updatedBy, userIds),
        ]);
      }

      await upsertBatched(client, "benchmark_prices", PRICE_HEAD_SQL, PRICE_TAIL_SQL, priceRows);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Seeded ${combosUpserted} benchmark combos and ${priceResult.recordset.length - skippedPricesMissingMaterialOrLocation - skippedPricesMissingDate} benchmark prices ` +
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

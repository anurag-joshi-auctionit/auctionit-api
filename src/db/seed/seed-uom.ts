import pg from "pg";
import { env } from "../../env.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { connectMssql } from "./mssql.js";

/**
 * MSSQL master stores bare units (PKg, PMT). Auction lots store currency-prefixed
 * strings (RsPKg, AEDPMT). We only seed the prefixed codes used at runtime —
 * no bare PLt / PKg rows, no synthetic 10000/20000 id offsets.
 */
const CURRENCY_PREFIXES = ["Rs", "AED"] as const;

const SOURCE_SQL = `
SELECT
  Id AS id,
  LTRIM(RTRIM(UOMText)) AS code
FROM tbl_Config_Item_UOM
ORDER BY Id
`;

const LOT_UOM_SQL = `
SELECT
  LotId AS id,
  LTRIM(RTRIM(UOM)) AS uomCode
FROM tbl_Data_AuctionLot
WHERE UOM IS NOT NULL AND LTRIM(RTRIM(UOM)) <> ''
`;

const UPSERT_SQL = `
INSERT INTO uoms (id, code, is_active, created_at, created_by)
VALUES ($1, $2, $3, NOW(), $4)
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code,
  is_active = EXCLUDED.is_active,
  updated_at = NOW(),
  updated_by = $4,
  created_by = COALESCE(uoms.created_by, EXCLUDED.created_by)
`;

type SourceRow = {
  id: number;
  code: string | null;
};

type UomRefRow = {
  id: number;
  uomCode: string | null;
};

function stripKnownPrefix(code: string): string {
  const lower = code.toLowerCase();
  for (const prefix of ["aed", "rs", "inr", "usd"]) {
    if (lower.startsWith(prefix) && code.length > prefix.length) {
      return code.slice(prefix.length);
    }
  }
  return code;
}

function buildPrefixedCodes(raw: string): string[] {
  const base = stripKnownPrefix(raw.trim());
  if (!base) return [];
  return CURRENCY_PREFIXES.map((prefix) => `${prefix}${base}`.slice(0, 20));
}

function resolveUomId(
  code: string | null | undefined,
  uomMap: Map<string, number>,
): number | null {
  const trimmed = code?.trim();
  if (!trimmed) return null;
  const exact = uomMap.get(trimmed.toLowerCase());
  if (exact != null) return exact;
  // Bare codes like "Kg" / "PMT" → prefer Rs-prefixed master row.
  for (const prefix of CURRENCY_PREFIXES) {
    const prefixed = uomMap.get(`${prefix}${trimmed}`.toLowerCase());
    if (prefixed != null) return prefixed;
    const withP = trimmed.toLowerCase().startsWith("p")
      ? null
      : uomMap.get(`${prefix}P${trimmed}`.toLowerCase());
    if (withP != null) return withP;
  }
  const base = stripKnownPrefix(trimmed);
  if (base !== trimmed) {
    for (const prefix of CURRENCY_PREFIXES) {
      const id = uomMap.get(`${prefix}${base}`.toLowerCase());
      if (id != null) return id;
    }
  }
  return null;
}

async function rematchTableUoms(
  client: pg.PoolClient,
  table: "auction_lots",
  rows: UomRefRow[],
  uomMap: Map<string, number>,
): Promise<{ updated: number; unmatched: number }> {
  const pairs: Array<{ id: number; uomId: number }> = [];
  let unmatched = 0;
  for (const row of rows) {
    const uomId = resolveUomId(row.uomCode, uomMap);
    if (uomId == null) {
      unmatched++;
      continue;
    }
    pairs.push({ id: row.id, uomId });
  }

  if (pairs.length === 0) {
    return { updated: 0, unmatched };
  }

  const ids = pairs.map((p) => p.id);
  const uomIds = pairs.map((p) => p.uomId);
  const result = await client.query(
    `UPDATE ${table} AS t
     SET uom_id = v.uom_id
     FROM (
       SELECT UNNEST($1::int[]) AS id, UNNEST($2::smallint[]) AS uom_id
     ) AS v
     WHERE t.id = v.id`,
    [ids, uomIds],
  );
  return { updated: result.rowCount ?? 0, unmatched };
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(`Pulled ${result.recordset.length} UOM rows from MSSQL.`);
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const codes: string[] = [];
    const seen = new Set<string>();
    for (const r of result.recordset) {
      const raw = r.code?.trim();
      if (!raw) continue;
      for (const code of buildPrefixedCodes(raw)) {
        const key = code.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        codes.push(code);
      }
    }

    const lotUoms = await mssqlPool.request().query<UomRefRow>(LOT_UOM_SQL);

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      // Clear FKs then replace master so ids stay sequential 1..N.
      await client.query("UPDATE auction_lots SET uom_id = NULL WHERE uom_id IS NOT NULL");
      await client.query("UPDATE items SET uom_id = NULL WHERE uom_id IS NOT NULL");
      await client.query("DELETE FROM uoms");

      let nextId = 1;
      const uomMap = new Map<string, number>();
      let inactiveAed = 0;
      for (const code of codes) {
        const isActive = !code.toUpperCase().startsWith("AED");
        if (!isActive) inactiveAed++;
        await client.query(UPSERT_SQL, [
          nextId,
          code,
          isActive,
          SEED_DEFAULT_USER_ID,
        ]);
        uomMap.set(code.toLowerCase(), nextId);
        nextId++;
      }

      const lots = await rematchTableUoms(
        client,
        "auction_lots",
        lotUoms.recordset,
        uomMap,
      );

      await client.query("COMMIT");

      console.log(
        `Seeded ${codes.length} currency-prefixed uoms (ids 1..${codes.length}, AED inactive=${inactiveAed}) in ${Date.now() - started}ms.`,
      );
      console.log(`Codes: ${codes.join(", ")}`);
      console.log(
        `Rematched auction_lots uom_id: updated=${lots.updated}, unmatched=${lots.unmatched}`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

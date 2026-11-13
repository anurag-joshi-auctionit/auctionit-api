import { parseLoadingScope } from "@auctionit/lib/loading-scope";
import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import { upsertBatched } from "./batch-write.js";

const LOTS_SQL = `
SELECT
  LotId AS id,
  ClientId AS clientId,
  AuctionId AS auctionId,
  LotNumber AS lotNumber,
  TotalQuantity AS quantity,
  StartPrice AS startBidPrice,
  LTRIM(RTRIM(UOM)) AS uomCode,
  BidIncrement AS bidIncrement,
  BidQuantityIncrement AS bidQuantityIncrement,
  MaxBidLimit AS bidLimit,
  DisplayOrder AS displayOrder,
  CONVERT(varchar(33), LotStartTime, 126) AS lotStartTime,
  CONVERT(varchar(33), LotEndTime, 126) AS lotEndTime,
  PlantLocation AS plantLocationId,
  MaterialLocation AS materialLocationId,
  MaterialLiftingDays AS materialLiftingDays,
  LoadingArrangement AS loadingArrangement,
  GST_per AS gstPercentage,
  TCS_per AS tcsPercentage,
  Status AS status,
  IsApproved AS isApproved,
  CAST(NULL AS varchar(33)) AS reviewedAt,
  CAST(NULL AS int) AS reviewedBy,
  WinnerUserId AS winnerUserId,
  WinnerCompId AS winnerBidderId,
  WiningAmount AS winningAmount,
  NoOfTimeAutoIncrement AS noBidExtensionCount,
  Remark AS remark,
  IsActive AS isActive,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy AS updatedBy
FROM tbl_Data_AuctionLot
ORDER BY LotId
`;

const LOT_ITEMS_SQL = `
SELECT
  li.id AS id,
  li.ClientId AS clientId,
  li.AuctionId AS auctionId,
  li.LotID AS lotId,
  li.ItemId AS itemId,
  li.Quantity AS quantity,
  li.MaterialName AS materialName,
  li.MaterialDesc AS materialDescription,
  li.BenchmarkMaterialId AS benchmarkMaterialId,
  li.BenchmarkLocationId AS benchmarkLocationId,
  LTRIM(RTRIM(bm.MeterialName)) AS benchmarkMaterialName,
  LTRIM(RTRIM(bl.LocationName)) AS benchmarkLocationName,
  li.IsActive AS isActive,
  CONVERT(varchar(33), li.CreateDatetime, 126) AS createdAt,
  li.CreatedBy AS createdBy,
  CONVERT(varchar(33), li.UpdateDatetime, 126) AS updatedAt,
  li.UpdatedBy AS updatedBy
FROM tbl_Data_Auction_Lot_Items li
LEFT JOIN tbl_Config_BenchMarkMeterialMst bm
  ON bm.MaterialId = li.BenchmarkMaterialId
LEFT JOIN tbl_Config_BenchMarkLocation bl
  ON bl.LocationId = li.BenchmarkLocationId
ORDER BY li.id
`;

const UPSERT_LOT_HEAD = `
INSERT INTO auction_lots (
  id, client_id, auction_id, lot_number,
  quantity, start_bid_price, uom_id, bid_increment, bid_quantity_increment,
  bid_limit, display_order, start_time, end_time,
  plant_location_id, material_location_id,
  material_lifting_days, loading_scope, gst_percentage, tcs_percentage,
  status, is_approved, reviewed_at, reviewed_by,
  winner_user_id, winner_bidder_id, winning_amount,
  no_bid_extension_count, remark, is_active,
  created_at, created_by, updated_at, updated_by,
  is_no_bid_extension
)
`;

const UPSERT_LOT_TAIL = `
ON CONFLICT (id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  auction_id = EXCLUDED.auction_id,
  lot_number = EXCLUDED.lot_number,
  quantity = EXCLUDED.quantity,
  start_bid_price = EXCLUDED.start_bid_price,
  uom_id = EXCLUDED.uom_id,
  bid_increment = EXCLUDED.bid_increment,
  bid_quantity_increment = EXCLUDED.bid_quantity_increment,
  bid_limit = EXCLUDED.bid_limit,
  display_order = EXCLUDED.display_order,
  start_time = EXCLUDED.start_time,
  end_time = EXCLUDED.end_time,
  plant_location_id = EXCLUDED.plant_location_id,
  material_location_id = EXCLUDED.material_location_id,
  material_lifting_days = EXCLUDED.material_lifting_days,
  loading_scope = EXCLUDED.loading_scope,
  gst_percentage = EXCLUDED.gst_percentage,
  tcs_percentage = EXCLUDED.tcs_percentage,
  status = EXCLUDED.status,
  is_approved = EXCLUDED.is_approved,
  reviewed_at = EXCLUDED.reviewed_at,
  reviewed_by = EXCLUDED.reviewed_by,
  winner_user_id = EXCLUDED.winner_user_id,
  winner_bidder_id = EXCLUDED.winner_bidder_id,
  winning_amount = EXCLUDED.winning_amount,
  no_bid_extension_count = EXCLUDED.no_bid_extension_count,
  remark = EXCLUDED.remark,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by,
  is_no_bid_extension = EXCLUDED.is_no_bid_extension
`;

const UPSERT_LOT_ITEM_HEAD = `
INSERT INTO auction_lot_items (
  id, client_id, auction_id, lot_id, item_id, quantity,
  benchmark_material_location_id, material_name, material_description,
  is_active, created_at, created_by, updated_at, updated_by
)
`;

const UPSERT_LOT_ITEM_TAIL = `
ON CONFLICT (id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  auction_id = EXCLUDED.auction_id,
  lot_id = EXCLUDED.lot_id,
  item_id = EXCLUDED.item_id,
  quantity = EXCLUDED.quantity,
  benchmark_material_location_id = EXCLUDED.benchmark_material_location_id,
  material_name = EXCLUDED.material_name,
  material_description = EXCLUDED.material_description,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

function asString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Extract `HH:mm:ss` from an ISO/MSSQL datetime string for Postgres `time`. */
function asTimeOfDay(v: string | null | undefined): string | null {
  const text = asString(v);
  if (!text) return null;
  const timeOnly = text.match(/(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/);
  if (!timeOnly) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Number(timeOnly[1]))}:${timeOnly[2]}:${pad(Number(timeOnly[3] ?? 0))}`;
}

function numericOrNull(v: string | number | null | undefined): string | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(v) : null;
}

function intOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeComboKey(material: string, location: string): string {
  return `${material.trim().toLowerCase()}@@${location.trim().toLowerCase()}`;
}

async function loadUomMap(pool: pg.Pool): Promise<Map<string, number>> {
  const res = await pool.query<{ id: number; code: string }>(
    "SELECT id, code FROM uoms",
  );
  const map = new Map<string, number>();
  for (const row of res.rows) {
    map.set(row.code.trim().toLowerCase(), row.id);
  }
  return map;
}

async function loadBenchmarkComboMap(
  pool: pg.Pool,
): Promise<Map<string, number>> {
  const res = await pool.query<{
    id: number;
    material: string;
    location: string;
  }>(
    `SELECT bml.id, bm.name AS material, bl.name AS location
     FROM benchmark_material_locations bml
     JOIN benchmark_materials bm ON bm.id = bml.material_id
     JOIN benchmark_locations bl ON bl.id = bml.location_id`,
  );
  const map = new Map<string, number>();
  for (const row of res.rows) {
    map.set(normalizeComboKey(row.material, row.location), row.id);
  }
  return map;
}

function resolveUomId(
  code: string | null,
  uomMap: Map<string, number>,
  unmatched: Set<string>,
): number | null {
  const trimmed = asString(code);
  if (!trimmed) return null;
  const exact = uomMap.get(trimmed.toLowerCase());
  if (exact != null) return exact;
  for (const prefix of ["rs", "aed"] as const) {
    const prefixed = uomMap.get(`${prefix}${trimmed}`.toLowerCase());
    if (prefixed != null) return prefixed;
    if (!trimmed.toLowerCase().startsWith("p")) {
      const withP = uomMap.get(`${prefix}p${trimmed}`.toLowerCase());
      if (withP != null) return withP;
    }
  }
  unmatched.add(trimmed);
  return null;
}

function resolveBenchmarkComboId(
  materialName: string | null,
  locationName: string | null,
  materialId: number | null,
  locationId: number | null,
  comboMap: Map<string, number>,
  stats: {
    nullSource: number;
    resolved: number;
    unresolved: number;
    samples: string[];
  },
): number | null {
  if (materialId == null && locationId == null) {
    stats.nullSource++;
    return null;
  }
  const material = asString(materialName);
  const location = asString(locationName);
  if (!material || !location) {
    stats.unresolved++;
    if (stats.samples.length < 10) {
      stats.samples.push(
        `ids=${materialId ?? "null"}/${locationId ?? "null"} (missing name)`,
      );
    }
    return null;
  }
  const id = comboMap.get(normalizeComboKey(material, location));
  if (id == null) {
    stats.unresolved++;
    if (stats.samples.length < 10) {
      stats.samples.push(`${material}@@${location}`);
    }
    return null;
  }
  stats.resolved++;
  return id;
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const [lotsResult, itemsResult] = await Promise.all([
      mssqlPool.request().query(LOTS_SQL),
      mssqlPool.request().query(LOT_ITEMS_SQL),
    ]);
    console.log(
      `Pulled ${lotsResult.recordset.length} lot rows and ${itemsResult.recordset.length} lot item rows from MSSQL.`,
    );

    const [
      uomMap,
      benchmarkComboMap,
      auctionIds,
      clientIds,
      userIds,
      plantLocationIds,
      materialLocationIds,
      bidderIds,
      itemIds,
    ] = await Promise.all([
      loadUomMap(pgPool),
      loadBenchmarkComboMap(pgPool),
      pgPool.query<{ id: number; is_no_bid_extension: boolean }>(
        "SELECT auction_id AS id, is_no_bid_extension FROM auctions",
      ),
      pgPool.query<{ id: number }>("SELECT id FROM clients"),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
      pgPool.query<{ id: number }>("SELECT id FROM plant_locations"),
      pgPool.query<{ id: number }>("SELECT id FROM material_locations"),
      pgPool.query<{ id: number }>("SELECT id FROM bidders"),
      pgPool.query<{ id: number }>("SELECT id FROM items"),
    ]);

    if (benchmarkComboMap.size === 0) {
      console.warn(
        "benchmark_material_locations is empty — run seed:benchmarks before seed:auction-lots for historical benchmark FKs.",
      );
    }

    const validAuctionIds = new Set(auctionIds.rows.map((r) => r.id));
    const auctionNoBidExtension = new Map(
      auctionIds.rows.map((r) => [r.id, r.is_no_bid_extension ?? true] as const),
    );
    const validClientIds = new Set(clientIds.rows.map((r) => r.id));
    const validUserIds = new Set(userIds.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);
    const validPlantIds = new Set(plantLocationIds.rows.map((r) => r.id));
    const validMaterialIds = new Set(materialLocationIds.rows.map((r) => r.id));
    const validBidderIds = new Set(bidderIds.rows.map((r) => r.id));
    const validItemIds = new Set(itemIds.rows.map((r) => r.id));

    const unmatchedUoms = new Set<string>();
    const benchmarkStats = {
      nullSource: 0,
      resolved: 0,
      unresolved: 0,
      samples: [] as string[],
    };
    const client = await pgPool.connect();
    let lotsUpserted = 0;
    let lotsSkippedMissingAuction = 0;
    let lotsSkippedMissingClient = 0;
    let itemsUpserted = 0;
    let itemsSkippedMissingAuction = 0;
    let itemsSkippedMissingClient = 0;
    let itemsSkippedMissingLot = 0;

    try {
      await client.query("BEGIN");

      const lotRows: unknown[][] = [];
      for (const r of lotsResult.recordset) {
        if (!validAuctionIds.has(r.auctionId)) {
          lotsSkippedMissingAuction++;
          continue;
        }
        if (!validClientIds.has(r.clientId)) {
          lotsSkippedMissingClient++;
          continue;
        }

        const plantLocationId =
          r.plantLocationId != null && validPlantIds.has(r.plantLocationId)
            ? r.plantLocationId
            : null;
        const materialLocationId =
          r.materialLocationId != null &&
          validMaterialIds.has(r.materialLocationId)
            ? r.materialLocationId
            : null;
        const winnerBidderId =
          r.winnerBidderId != null && validBidderIds.has(r.winnerBidderId)
            ? r.winnerBidderId
            : null;
        const winnerUserId =
          r.winnerUserId != null && validUserIds.has(r.winnerUserId)
            ? r.winnerUserId
            : null;
        const createdBy = resolveAuditUserId(r.createdBy, validUserIds);
        const updatedBy = resolveAuditUserIdIfTimestamp(
          r.updatedAt,
          r.updatedBy,
          validUserIds,
        );

        const reviewedBy =
          r.reviewedBy != null && validUserIds.has(r.reviewedBy)
            ? r.reviewedBy
            : null;

        lotRows.push([
          r.id,
          r.clientId,
          r.auctionId,
          asString(r.lotNumber),
          numericOrNull(r.quantity),
          numericOrNull(r.startBidPrice),
          resolveUomId(r.uomCode, uomMap, unmatchedUoms),
          numericOrNull(r.bidIncrement),
          numericOrNull(r.bidQuantityIncrement),
          numericOrNull(r.bidLimit),
          numericOrNull(r.displayOrder),
          asTimeOfDay(r.lotStartTime),
          asTimeOfDay(r.lotEndTime),
          plantLocationId,
          materialLocationId,
          intOrNull(r.materialLiftingDays),
          parseLoadingScope(r.loadingArrangement),
          numericOrNull(r.gstPercentage),
          numericOrNull(r.tcsPercentage),
          r.status,
          r.isApproved == null ? null : Boolean(r.isApproved),
          r.reviewedAt,
          reviewedBy,
          winnerUserId,
          winnerBidderId,
          numericOrNull(r.winningAmount),
          intOrNull(r.noBidExtensionCount) ?? 0,
          asString(r.remark),
          Boolean(r.isActive),
          r.createdAt,
          createdBy,
          r.updatedAt,
          updatedBy,
          auctionNoBidExtension.get(r.auctionId) ?? true,
        ]);
        lotsUpserted++;
      }
      await upsertBatched(client, "auction_lots", UPSERT_LOT_HEAD, UPSERT_LOT_TAIL, lotRows);

      const seededLotIds = new Set(
        lotsResult.recordset
          .filter(
            (r: { auctionId: number; clientId: number }) =>
              validAuctionIds.has(r.auctionId) &&
              validClientIds.has(r.clientId),
          )
          .map((r: { id: number }) => r.id),
      );

      const itemRows: unknown[][] = [];
      for (const r of itemsResult.recordset) {
        if (!validAuctionIds.has(r.auctionId)) {
          itemsSkippedMissingAuction++;
          continue;
        }
        if (!validClientIds.has(r.clientId)) {
          itemsSkippedMissingClient++;
          continue;
        }
        if (!seededLotIds.has(r.lotId)) {
          itemsSkippedMissingLot++;
          continue;
        }

        const itemId =
          r.itemId != null && validItemIds.has(r.itemId) ? r.itemId : null;
        const createdBy = resolveAuditUserId(r.createdBy, validUserIds);
        const updatedBy = resolveAuditUserIdIfTimestamp(
          r.updatedAt,
          r.updatedBy,
          validUserIds,
        );

        const benchmarkMaterialLocationId = resolveBenchmarkComboId(
          r.benchmarkMaterialName,
          r.benchmarkLocationName,
          r.benchmarkMaterialId != null ? Number(r.benchmarkMaterialId) : null,
          r.benchmarkLocationId != null ? Number(r.benchmarkLocationId) : null,
          benchmarkComboMap,
          benchmarkStats,
        );

        itemRows.push([
          r.id,
          r.clientId,
          r.auctionId,
          r.lotId,
          itemId,
          numericOrNull(r.quantity) ?? "0",
          benchmarkMaterialLocationId,
          asString(r.materialName),
          asString(r.materialDescription),
          Boolean(r.isActive),
          r.createdAt,
          createdBy,
          r.updatedAt,
          updatedBy,
        ]);
        itemsUpserted++;
      }
      await upsertBatched(
        client,
        "auction_lot_items",
        UPSERT_LOT_ITEM_HEAD,
        UPSERT_LOT_ITEM_TAIL,
        itemRows,
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (unmatchedUoms.size > 0) {
      console.warn(
        `Unmatched UOM codes (${unmatchedUoms.size}): ${[...unmatchedUoms].slice(0, 20).join(", ")}${unmatchedUoms.size > 20 ? "…" : ""}`,
      );
    }

    console.log(
      `Benchmark resolve: resolved=${benchmarkStats.resolved}, unresolved=${benchmarkStats.unresolved}, null-source=${benchmarkStats.nullSource}`,
    );
    if (benchmarkStats.samples.length > 0) {
      console.warn(
        `Unresolved benchmark samples: ${benchmarkStats.samples.join("; ")}`,
      );
    }

    console.log(
      `Upserted ${lotsUpserted} auction_lots ` +
        `(${lotsSkippedMissingAuction} skipped: auction not in Postgres, ` +
        `${lotsSkippedMissingClient} skipped: client not in Postgres) and ` +
        `${itemsUpserted} auction_lot_items ` +
        `(${itemsSkippedMissingAuction} skipped: auction not in Postgres, ` +
        `${itemsSkippedMissingClient} skipped: client not in Postgres, ` +
        `${itemsSkippedMissingLot} skipped: lot not in Postgres) ` +
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

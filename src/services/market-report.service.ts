import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { AdminReportsMessages } from "@auctionit/messages/reports";
import { db } from "../db/index.js";
import {
  benchmarkMaterialLocations,
  type BenchmarkCurrency,
} from "../db/schema/benchmark-material-locations.js";
import { benchmarkMaterials } from "../db/schema/benchmark-materials.js";
import { benchmarkLocations } from "../db/schema/benchmark-locations.js";
import { benchmarkPrices } from "../db/schema/benchmark-prices.js";
import { inrSeriesLabel } from "../lib/benchmarks/labels.js";
import {
  AdminReportsNotFoundError,
  type AdminReportAuctionOption,
} from "./admin-reports.service.js";

export class MarketReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketReportValidationError";
  }
}

export type MarketReportBenchmarkOption = {
  id: number;
  material: string;
  location: string;
};

export type MarketReportHeader = {
  auctionId: number;
  auctionNumber: string | null;
  /** `YYYY-MM-DD` */
  auctionDate: string;
  clientName: string;
  /** `HH:MM` (24h), earliest active lot start. */
  startTime: string | null;
  /** `HH:MM` (24h), latest active lot end (extended end when set). */
  endTime: string | null;
};

export type MarketReportSeries = {
  comboId: number;
  material: string;
  location: string;
  /** Currency prices were entered in; trend values are always INR. */
  currency: BenchmarkCurrency;
  label: string;
};

export type MarketReportTrendRow = {
  /** `YYYY-MM-DD` */
  date: string;
  /** INR, keyed by `comboId`; gaps carry the previous price, leading gaps are null. */
  prices: Record<string, number | null>;
};

export type MarketReportLotRow = {
  lotNumber: string | null;
  description: string | null;
  quantity: number | null;
  /** `YYYY-MM-DD` */
  previousAuctionDate: string | null;
  /** Benchmark prices are INR (converted when the benchmark is quoted in USD). */
  previousBenchmarkPrice: number | null;
  currentBenchmarkPrice: number | null;
  previousSbp: number | null;
  previousWinningPrice: number | null;
  suggestedSbp: number | null;
};

export type MarketReport = {
  header: MarketReportHeader;
  series: MarketReportSeries[];
  /** Oldest date first. */
  rows: MarketReportTrendRow[];
  lots: MarketReportLotRow[];
};

export type MarketReportParams = {
  clientId: number;
  auctionId: number;
  from: string;
  to: string;
  comboIds: number[];
};

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Upcoming = published, active, and scheduled for today (IST) or later. */
const upcomingAuctionSql = sql`
  a.status = 'published'
  AND a.is_active = true
  AND a.auction_date::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date
`;

async function queryHeader(
  clientId: number,
  auctionId: number,
): Promise<MarketReportHeader> {
  const res = await db.execute<{
    auction_id: number;
    auction_number: string | null;
    auction_date: string;
    client_name: string;
    start_time: string | null;
    end_time: string | null;
    upcoming: boolean;
  }>(sql`
    SELECT a.auction_id,
           a.auction_number,
           to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
           c.company_name AS client_name,
           (${upcomingAuctionSql}) AS upcoming,
           to_char(lt.start_time, 'HH24:MI') AS start_time,
           to_char(lt.end_time, 'HH24:MI') AS end_time
    FROM auctions a
    JOIN clients c ON c.id = a.client_id
    LEFT JOIN LATERAL (
      SELECT min(l.start_time) AS start_time,
             max(COALESCE(
               (l.extended_end_time AT TIME ZONE 'Asia/Kolkata')::time,
               l.end_time
             )) AS end_time
      FROM auction_lots l
      WHERE l.auction_id = a.auction_id AND l.is_active = true
    ) lt ON true
    WHERE a.auction_id = ${auctionId}
      AND a.client_id = ${clientId}
    LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) {
    throw new AdminReportsNotFoundError(AdminReportsMessages.AUCTION_NOT_FOUND);
  }
  if (!row.upcoming) {
    throw new MarketReportValidationError(
      AdminReportsMessages.MARKET_AUCTION_NOT_ELIGIBLE,
    );
  }
  return {
    auctionId: row.auction_id,
    auctionNumber: row.auction_number,
    auctionDate: row.auction_date,
    clientName: row.client_name,
    startTime: row.start_time,
    endTime: row.end_time,
  };
}

async function queryTrend(
  params: Pick<MarketReportParams, "from" | "to" | "comboIds">,
): Promise<Pick<MarketReport, "series" | "rows">> {
  const combos = await db
    .select({
      id: benchmarkMaterialLocations.id,
      material: benchmarkMaterials.name,
      location: benchmarkLocations.name,
      currency: benchmarkMaterialLocations.currency,
    })
    .from(benchmarkMaterialLocations)
    .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
    .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id))
    .where(inArray(benchmarkMaterialLocations.id, params.comboIds));
  const comboById = new Map(combos.map((c) => [c.id, c]));
  if (params.comboIds.some((id) => !comboById.has(id))) {
    throw new MarketReportValidationError(
      AdminReportsMessages.MARKET_BENCHMARK_INVALID,
    );
  }
  const series: MarketReportSeries[] = params.comboIds.map((id) => {
    const c = comboById.get(id)!;
    return {
      comboId: c.id,
      material: c.material,
      location: c.location,
      currency: c.currency,
      label: inrSeriesLabel(`${c.material} (${c.location})`, c.currency),
    };
  });

  const priceRows = await db
    .select({
      comboId: benchmarkPrices.benchmarkMaterialLocationId,
      date: benchmarkPrices.benchmarkDate,
      price: benchmarkPrices.priceInr,
    })
    .from(benchmarkPrices)
    .where(
      and(
        inArray(benchmarkPrices.benchmarkMaterialLocationId, params.comboIds),
        gte(benchmarkPrices.benchmarkDate, params.from),
        lte(benchmarkPrices.benchmarkDate, params.to),
      ),
    )
    .orderBy(asc(benchmarkPrices.benchmarkDate));

  const pricesByDate = new Map<string, Map<number, number>>();
  for (const row of priceRows) {
    const price = toNumber(row.price);
    if (price == null || price === 0) continue;
    const date = String(row.date);
    let byCombo = pricesByDate.get(date);
    if (!byCombo) {
      byCombo = new Map();
      pricesByDate.set(date, byCombo);
    }
    byCombo.set(row.comboId, price);
  }

  const last = new Map<number, number>();
  const rows: MarketReportTrendRow[] = [];
  for (const [date, byCombo] of pricesByDate) {
    const prices: Record<string, number | null> = {};
    for (const s of series) {
      const price = byCombo.get(s.comboId);
      if (price != null) last.set(s.comboId, price);
      prices[String(s.comboId)] = last.get(s.comboId) ?? null;
    }
    rows.push({ date, prices });
  }
  return { series, rows };
}

async function queryLots(
  clientId: number,
  auctionId: number,
  auctionDate: string,
): Promise<MarketReportLotRow[]> {
  const res = await db.execute<{
    lot_number: string | null;
    description: string | null;
    quantity: string | null;
    suggested_sbp: string | null;
    prev_auction_date: string | null;
    prev_sbp: string | null;
    prev_winning_price: string | null;
    prev_benchmark: string | null;
    today_benchmark: string | null;
  }>(sql`
    SELECT l.lot_number,
           COALESCE(
             NULLIF(TRIM(i.name), ''),
             NULLIF(TRIM(ali.material_name), ''),
             NULLIF(TRIM(ali.material_description), '')
           ) AS description,
           ali.quantity,
           l.start_bid_price AS suggested_sbp,
           prev.auction_date AS prev_auction_date,
           prev.start_bid_price AS prev_sbp,
           prev.winning_amount AS prev_winning_price,
           CASE WHEN prev.auction_date IS NULL THEN NULL ELSE (
             SELECT bp.price_inr
             FROM benchmark_prices bp
             WHERE bp.benchmark_material_location_id = ali.benchmark_material_location_id
               AND bp.price_inr <> 0
               AND bp.benchmark_date < CAST(prev.auction_date AS date)
             ORDER BY bp.benchmark_date DESC
             LIMIT 1
           ) END AS prev_benchmark,
           (
             SELECT bp.price_inr
             FROM benchmark_prices bp
             WHERE bp.benchmark_material_location_id = ali.benchmark_material_location_id
               AND bp.price_inr <> 0
             ORDER BY bp.benchmark_date DESC
             LIMIT 1
           ) AS today_benchmark
    FROM auction_lots l
    JOIN auction_lot_items ali ON ali.lot_id = l.id AND ali.is_active = true
    LEFT JOIN items i ON i.id = ali.item_id
    LEFT JOIN LATERAL (
      SELECT to_char(pa.auction_date, 'YYYY-MM-DD') AS auction_date,
             pl.start_bid_price,
             pl.winning_amount
      FROM auction_lot_items pali
      JOIN auction_lots pl ON pl.id = pali.lot_id AND pl.is_active = true
      JOIN auctions pa ON pa.auction_id = pl.auction_id
        AND pa.is_active = true
        AND pa.status IN ('published', 'closed')
      WHERE pa.client_id = ${clientId}
        AND pa.auction_date::date < CAST(${auctionDate} AS date)
        AND pali.is_active = true
        AND pali.item_id = ali.item_id
        AND pali.benchmark_material_location_id = ali.benchmark_material_location_id
      ORDER BY pa.auction_date DESC, pl.id DESC
      LIMIT 1
    ) prev ON true
    WHERE l.auction_id = ${auctionId}
      AND l.is_active = true
    ORDER BY l.display_order NULLS LAST, l.id, ali.id
  `);
  return res.rows.map((r) => ({
    lotNumber: r.lot_number,
    description: r.description,
    quantity: toNumber(r.quantity),
    previousAuctionDate: r.prev_auction_date,
    previousBenchmarkPrice: toNumber(r.prev_benchmark),
    currentBenchmarkPrice: toNumber(r.today_benchmark),
    previousSbp: toNumber(r.prev_sbp),
    previousWinningPrice: toNumber(r.prev_winning_price),
    suggestedSbp: toNumber(r.suggested_sbp),
  }));
}

export const marketReportService = {
  async listAuctions(clientId: number): Promise<AdminReportAuctionOption[]> {
    const res = await db.execute<{
      auction_id: number;
      auction_number: string | null;
      auction_date: string | null;
    }>(sql`
      SELECT a.auction_id, a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date
      FROM auctions a
      WHERE a.client_id = ${clientId}
        AND ${upcomingAuctionSql}
      ORDER BY a.auction_date ASC, a.auction_id ASC
    `);
    return res.rows.map((r) => ({
      auctionId: r.auction_id,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
    }));
  },

  async listBenchmarkOptions(): Promise<MarketReportBenchmarkOption[]> {
    return db
      .select({
        id: benchmarkMaterialLocations.id,
        material: benchmarkMaterials.name,
        location: benchmarkLocations.name,
      })
      .from(benchmarkMaterialLocations)
      .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
      .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id))
      .where(eq(benchmarkMaterialLocations.isActive, true))
      .orderBy(asc(benchmarkMaterials.name), asc(benchmarkLocations.name));
  },

  async build(params: MarketReportParams): Promise<MarketReport> {
    const header = await queryHeader(params.clientId, params.auctionId);
    const [trend, lots] = await Promise.all([
      queryTrend(params),
      queryLots(params.clientId, params.auctionId, header.auctionDate),
    ]);
    return { header, ...trend, lots };
  },
};

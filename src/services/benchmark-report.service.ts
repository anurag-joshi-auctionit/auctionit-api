import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  benchmarkMaterialLocations,
  type BenchmarkCurrency,
} from "../db/schema/benchmark-material-locations.js";
import { benchmarkMaterials } from "../db/schema/benchmark-materials.js";
import { benchmarkLocations } from "../db/schema/benchmark-locations.js";
import { benchmarkPrices } from "../db/schema/benchmark-prices.js";
import { inrSeriesLabel } from "../lib/benchmarks/labels.js";
import { benchmarkMaterialLocationsService } from "./benchmark-material-locations.service.js";

export type BenchmarkReportSeries = {
  comboId: number;
  location: string;
  /** Currency prices were entered in; report values are always INR. */
  currency: BenchmarkCurrency;
  /** Location, suffixed with ` (INR)` when converted from another currency. */
  label: string;
};

export type BenchmarkReportRow = {
  date: string;
  /** INR, keyed by `comboId`; missing key → no price entered for that date. */
  prices: Record<string, number>;
};

export type BenchmarkReport = {
  material: string;
  series: BenchmarkReportSeries[];
  /** Newest date first; only dates with at least one price. */
  rows: BenchmarkReportRow[];
};

export type BenchmarkReportParams = {
  material: string;
  from: string;
  to: string;
};

export const benchmarkReportService = {
  listMaterials(): Promise<string[]> {
    return benchmarkMaterialLocationsService.listActiveMaterials();
  },

  async report(params: BenchmarkReportParams): Promise<BenchmarkReport> {
    const priceRows = await db
      .select({
        comboId: benchmarkMaterialLocations.id,
        location: benchmarkLocations.name,
        currency: benchmarkMaterialLocations.currency,
        date: benchmarkPrices.benchmarkDate,
        priceInr: benchmarkPrices.priceInr,
      })
      .from(benchmarkPrices)
      .innerJoin(
        benchmarkMaterialLocations,
        eq(
          benchmarkPrices.benchmarkMaterialLocationId,
          benchmarkMaterialLocations.id,
        ),
      )
      .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
      .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id))
      .where(
        and(
          eq(benchmarkMaterials.name, params.material),
          gte(benchmarkPrices.benchmarkDate, params.from),
          lte(benchmarkPrices.benchmarkDate, params.to),
        ),
      )
      .orderBy(
        desc(benchmarkPrices.benchmarkDate),
        asc(benchmarkLocations.name),
      );

    const seriesById = new Map<number, BenchmarkReportSeries>();
    const rowsByDate = new Map<string, BenchmarkReportRow>();

    for (const row of priceRows) {
      if (!seriesById.has(row.comboId)) {
        seriesById.set(row.comboId, {
          comboId: row.comboId,
          location: row.location,
          currency: row.currency,
          label: inrSeriesLabel(row.location, row.currency),
        });
      }
      const date = String(row.date);
      let reportRow = rowsByDate.get(date);
      if (!reportRow) {
        reportRow = { date, prices: {} };
        rowsByDate.set(date, reportRow);
      }
      reportRow.prices[String(row.comboId)] = Number(row.priceInr);
    }

    const series = [...seriesById.values()].sort((a, b) =>
      a.location.localeCompare(b.location),
    );

    return {
      material: params.material,
      series,
      rows: [...rowsByDate.values()],
    };
  },
};

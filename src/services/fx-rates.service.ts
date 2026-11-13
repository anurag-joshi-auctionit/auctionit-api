import { and, desc, eq, lte, sql } from "drizzle-orm";
import { BenchmarksErrorMessages } from "@auctionit/messages/benchmarks";
import { db } from "../db/index.js";
import {
  BENCHMARK_BASE_CURRENCY,
  type BenchmarkCurrency,
} from "../db/schema/benchmark-material-locations.js";
import { fxRates } from "../db/schema/fx-rates.js";
import { env } from "../env.js";
import { formatRate } from "../lib/fx/convert.js";
import {
  fetchRate,
  fetchRateRange,
  type FxRatePoint,
} from "../lib/fx/frankfurter.js";

export const FX_SOURCE_FRANKFURTER = "frankfurter";

export type RateToInr = {
  /** 1 unit of the currency = `rate` INR. */
  rate: string;
  /** ECB publication date; null for INR. */
  rateDate: string | null;
};

export class FxRateUnavailableError extends Error {
  constructor(
    readonly currency: string,
    readonly date: string,
  ) {
    super(BenchmarksErrorMessages.FX_RATE_UNAVAILABLE);
    this.name = "FxRateUnavailableError";
  }
}

const DAY_MS = 86_400_000;

function toUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
function utcWeekday(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

/**
 * A cached rate published on `rateDate` is what the API would return for
 * `date`: same day, or `date` is a weekend and `rateDate` the Friday before.
 */
export function isCachedRateCurrent(rateDate: string, date: string): boolean {
  const gap = daysBetween(rateDate, date);
  if (gap === 0) return true;
  const weekday = utcWeekday(date);
  if (weekday === 6) return gap === 1;
  if (weekday === 0) return gap === 2;
  return false;
}

async function latestCachedRate(
  base: string,
  date: string,
): Promise<FxRatePoint | null> {
  const [row] = await db
    .select({ rateDate: fxRates.rateDate, rate: fxRates.rate })
    .from(fxRates)
    .where(
      and(
        eq(fxRates.base, base),
        eq(fxRates.quote, BENCHMARK_BASE_CURRENCY),
        lte(fxRates.rateDate, date),
      ),
    )
    .orderBy(desc(fxRates.rateDate))
    .limit(1);
  return row ? { rateDate: String(row.rateDate), rate: Number(row.rate) } : null;
}

async function upsertRates(
  base: string,
  points: FxRatePoint[],
  source = FX_SOURCE_FRANKFURTER,
): Promise<number> {
  if (points.length === 0) return 0;
  await db
    .insert(fxRates)
    .values(
      points.map((p) => ({
        base,
        quote: BENCHMARK_BASE_CURRENCY,
        rateDate: p.rateDate,
        rate: formatRate(p.rate),
        source,
      })),
    )
    .onConflictDoUpdate({
      target: [fxRates.base, fxRates.quote, fxRates.rateDate],
      set: {
        rate: sql`excluded.rate`,
        source: sql`excluded.source`,
        fetchedAt: sql`now()`,
      },
    });
  return points.length;
}

function toRateToInr(point: FxRatePoint): RateToInr {
  return { rate: formatRate(point.rate), rateDate: point.rateDate };
}

export const fxRatesService = {
  /** INR short-circuits to rate 1 without touching the cache or the API. */
  async getRateToInr(
    currency: BenchmarkCurrency,
    date: string,
  ): Promise<RateToInr> {
    if (currency === BENCHMARK_BASE_CURRENCY) {
      return { rate: formatRate(1), rateDate: null };
    }

    const cached = await latestCachedRate(currency, date);
    if (cached && isCachedRateCurrent(cached.rateDate, date)) {
      return toRateToInr(cached);
    }

    try {
      const fetched = await fetchRate(currency, BENCHMARK_BASE_CURRENCY, date);
      await upsertRates(currency, [fetched]);
      return toRateToInr(fetched);
    } catch (err) {
      if (
        cached &&
        daysBetween(cached.rateDate, date) <= env.FX_RATE_MAX_STALENESS_DAYS
      ) {
        console.warn(
          `[fx] ${currency}/INR fetch failed for ${date}; using cached ${cached.rateDate}`,
          err,
        );
        return toRateToInr(cached);
      }
      console.error(`[fx] ${currency}/INR unavailable for ${date}`, err);
      throw new FxRateUnavailableError(currency, date);
    }
  },

  /** Loads business-day rates into the cache, one API call per calendar year. */
  async loadRange(
    currency: BenchmarkCurrency,
    from: string,
    to: string,
  ): Promise<number> {
    if (currency === BENCHMARK_BASE_CURRENCY) return 0;
    let loaded = 0;
    const endYear = Number(to.slice(0, 4));
    for (let year = Number(from.slice(0, 4)); year <= endYear; year++) {
      const chunkFrom = year === Number(from.slice(0, 4)) ? from : `${year}-01-01`;
      const chunkTo = year === endYear ? to : `${year}-12-31`;
      const points = await fetchRateRange(
        currency,
        BENCHMARK_BASE_CURRENCY,
        chunkFrom,
        chunkTo,
      );
      loaded += await upsertRates(currency, points);
    }
    return loaded;
  },
};

import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  BENCHMARK_BASE_CURRENCY,
  type BenchmarkCurrency,
} from "../db/schema/benchmark-material-locations.js";

type DbExecutor = Pick<typeof db, "execute">;

export type RateBenchmarkPricesOptions = {
  /** Limit to one material-location; omit to rate every price. */
  comboId?: number;
};

export type RateBenchmarkPricesResult = {
  inrRows: number;
  convertedRows: number;
  /** Non-INR rows with no cached rate on or before their benchmark date. */
  unratedRows: number;
};

function comboFilter(comboId: number | undefined): SQL {
  return comboId != null ? sql`AND bml.id = ${comboId}` : sql``;
}

/**
 * Recomputes `currency` / `exchange_rate` / `price_inr` / `rate_date` on
 * `benchmark_prices` from the combo currency: INR rows get rate 1 and
 * `price_inr = price`; other currencies use the latest `fx_rates` row on or
 * before `benchmark_date`. Only reads the `fx_rates` cache — load it first.
 */
export async function rateBenchmarkPrices(
  opts: RateBenchmarkPricesOptions = {},
  executor: DbExecutor = db,
): Promise<RateBenchmarkPricesResult> {
  const filter = comboFilter(opts.comboId);

  const inr = await executor.execute(sql`
    UPDATE benchmark_prices bp
    SET currency = ${BENCHMARK_BASE_CURRENCY},
        exchange_rate = 1,
        price_inr = bp.price,
        rate_date = NULL
    FROM benchmark_material_locations bml
    WHERE bml.id = bp.benchmark_material_location_id
      AND bml.currency = ${BENCHMARK_BASE_CURRENCY}
      ${filter}
  `);

  const converted = await executor.execute(sql`
    WITH rated AS (
      SELECT bp.id, bml.currency, fx.rate, fx.rate_date
      FROM benchmark_prices bp
      JOIN benchmark_material_locations bml
        ON bml.id = bp.benchmark_material_location_id
      JOIN LATERAL (
        SELECT f.rate, f.rate_date
        FROM fx_rates f
        WHERE f.base = bml.currency
          AND f.quote = ${BENCHMARK_BASE_CURRENCY}
          AND f.rate_date <= bp.benchmark_date
        ORDER BY f.rate_date DESC
        LIMIT 1
      ) fx ON true
      WHERE bml.currency <> ${BENCHMARK_BASE_CURRENCY}
        ${filter}
    )
    UPDATE benchmark_prices bp
    SET currency = rated.currency,
        exchange_rate = rated.rate,
        price_inr = round(bp.price * rated.rate, 2),
        rate_date = rated.rate_date
    FROM rated
    WHERE bp.id = rated.id
  `);

  const unrated = await executor.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM benchmark_prices bp
    JOIN benchmark_material_locations bml
      ON bml.id = bp.benchmark_material_location_id
    WHERE bml.currency <> ${BENCHMARK_BASE_CURRENCY}
      AND (bp.currency <> bml.currency OR bp.price_inr IS NULL)
      ${filter}
  `);

  return {
    inrRows: inr.rowCount ?? 0,
    convertedRows: converted.rowCount ?? 0,
    unratedRows: unrated.rows[0]?.n ?? 0,
  };
}

/** `benchmark_date` span of a combo's (or every non-INR combo's) prices. */
export async function nonInrPriceDateRange(
  opts: { comboId?: number; currency?: BenchmarkCurrency } = {},
  executor: DbExecutor = db,
): Promise<Array<{ currency: BenchmarkCurrency; from: string; to: string }>> {
  const res = await executor.execute<{
    currency: BenchmarkCurrency;
    from_date: string;
    to_date: string;
  }>(sql`
    SELECT ${
      opts.currency != null ? sql`${opts.currency}::varchar` : sql`bml.currency`
    } AS currency,
           to_char(min(bp.benchmark_date), 'YYYY-MM-DD') AS from_date,
           to_char(max(bp.benchmark_date), 'YYYY-MM-DD') AS to_date
    FROM benchmark_prices bp
    JOIN benchmark_material_locations bml
      ON bml.id = bp.benchmark_material_location_id
    WHERE bp.benchmark_date >= DATE '1999-01-04'
      ${
        opts.comboId != null
          ? sql`AND bml.id = ${opts.comboId}`
          : sql`AND bml.currency <> ${BENCHMARK_BASE_CURRENCY}`
      }
    GROUP BY 1
  `);
  return res.rows
    .filter((r) => r.from_date && r.to_date)
    .map((r) => ({ currency: r.currency, from: r.from_date, to: r.to_date }));
}

import {
  BENCHMARK_BASE_CURRENCY,
  type BenchmarkCurrency,
} from "../../db/schema/benchmark-material-locations.js";

/** Flags series whose prices were converted to INR from another currency. */
export function inrSeriesLabel(label: string, currency: BenchmarkCurrency): string {
  return currency === BENCHMARK_BASE_CURRENCY
    ? label
    : `${label} (${BENCHMARK_BASE_CURRENCY})`;
}

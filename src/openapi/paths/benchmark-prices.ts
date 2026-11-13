import { z } from "zod";
import {
  benchmarkPriceHistoryQuerySchema,
  benchmarkPricesBulkSchema,
  benchmarkPricesGridQuerySchema,
  benchmarkPricesListQuerySchema,
} from "../../lib/benchmarks/schemas.js";
import { ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  BenchmarkPriceBulkResult,
  BenchmarkPriceGrid,
  BenchmarkPriceHistory,
  BenchmarkPriceList,
} from "../responses/benchmark-prices.js";

// Docs for src/routes/benchmark-prices.ts — see docs/api/README.md.
const r = documentRouter("/benchmark-prices");

r.get("/grid", {
  summary: "Price entry grid for a date",
  description:
    "One row per active material-location combo with its price for `benchmarkDate` (null when not entered). " +
    "`materials` / `locations` accept repeated params or comma-separated values.",
  query: benchmarkPricesGridQuerySchema,
  responses: { 200: BenchmarkPriceGrid },
});

r.get("/", {
  summary: "List benchmark prices",
  description: "Paginated price history across combos, filterable by combo, material, location and date range.",
  query: benchmarkPricesListQuerySchema,
  responses: { 200: BenchmarkPriceList },
});

r.get("/history/:comboId", {
  summary: "Price history for one combo",
  params: z.object({
    comboId: z.coerce.number().int().positive().openapi({ param: { name: "comboId", in: "path" } }),
  }),
  query: benchmarkPriceHistoryQuerySchema,
  responses: {
    200: BenchmarkPriceHistory,
    400: { description: "Invalid benchmark id or query.", schema: ErrorBody },
    404: { description: "Benchmark not found.", schema: ErrorBody },
    503: { description: "Exchange rate unavailable.", schema: ErrorBody },
  },
});

r.post("/bulk", {
  summary: "Save prices for a date",
  description:
    "Upserts one price per combo for `benchmarkDate`. Prices are in each combo's currency and are converted to INR " +
    "with that date's exchange rate.",
  body: benchmarkPricesBulkSchema,
  responses: {
    200: BenchmarkPriceBulkResult,
    404: { description: "One of the combos does not exist.", schema: ErrorBody },
    503: { description: "No exchange rate available for a combo currency on that date.", schema: ErrorBody },
  },
});

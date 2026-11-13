import { paginated } from "../common.js";
import { z } from "../zod.js";
import { BenchmarkCurrency } from "./benchmark-material-locations.js";

// Mirrors BenchmarkPrice* types in services/benchmark-prices.service.ts.

const fx = {
  currency: BenchmarkCurrency,
  exchangeRate: z.string().openapi({ description: "Decimal string; rate to INR used for `priceInr`." }),
  priceInr: z.string().openapi({ description: "Decimal string; `price` converted to INR." }),
  rateDate: z.string().nullable().openapi({ description: "Date of the FX rate used (null for INR)." }),
};

export const BenchmarkPrice = z
  .object({
    id: z.number().int(),
    benchmarkMaterialLocationId: z.number().int(),
    material: z.string(),
    location: z.string(),
    benchmarkDate: z.string(),
    price: z.string().openapi({ description: "Decimal string in the combo currency." }),
    ...fx,
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi("BenchmarkPrice");

export const BenchmarkPriceList = paginated(BenchmarkPrice).openapi("BenchmarkPriceList");

export const BenchmarkPriceGridRow = z
  .object({
    benchmarkMaterialLocationId: z.number().int(),
    material: z.string(),
    location: z.string(),
    currency: BenchmarkCurrency.openapi({ description: "Combo currency — the currency `price` is entered in." }),
    price: z.string().nullable().openapi({ description: "Null when no price is entered for the date." }),
    priceId: z.number().int().nullable(),
    exchangeRate: z.string().nullable(),
    priceInr: z.string().nullable(),
    rateDate: z.string().nullable(),
  })
  .openapi("BenchmarkPriceGridRow");

export const BenchmarkPriceGrid = z
  .object({
    benchmarkDate: z.string(),
    items: z.array(BenchmarkPriceGridRow),
    filledCount: z.number().int().openapi({ description: "Matching combos that have a price for the date." }),
    totalCount: z.number().int().openapi({ description: "Matching active combos (all pages)." }),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi("BenchmarkPriceGrid");

export const BenchmarkPriceHistoryRow = z
  .object({
    id: z.number().int(),
    benchmarkDate: z.string(),
    price: z.string(),
    ...fx,
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi("BenchmarkPriceHistoryRow");

export const BenchmarkPriceHistory = z.array(BenchmarkPriceHistoryRow).openapi("BenchmarkPriceHistory");

export const BenchmarkPriceBulkResult = z
  .object({ upserted: z.number().int() })
  .openapi("BenchmarkPriceBulkResult");

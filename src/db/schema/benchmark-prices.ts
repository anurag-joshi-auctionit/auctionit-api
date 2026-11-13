import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import {
  benchmarkMaterialLocations,
  type BenchmarkCurrency,
} from "./benchmark-material-locations.js";
import { users } from "./users.js";

export const benchmarkPrices = pgTable(
  "benchmark_prices",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    benchmarkMaterialLocationId: integer("benchmark_material_location_id")
      .notNull()
      .references(() => benchmarkMaterialLocations.id),
    benchmarkDate: date("benchmark_date").notNull(),
    /** As entered, in `currency`. */
    price: numeric("price", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 })
      .$type<BenchmarkCurrency>()
      .notNull()
      .default("INR"),
    /** 1 unit of `currency` = `exchangeRate` INR; always 1 for INR. */
    exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 })
      .notNull()
      .default("1"),
    priceInr: numeric("price_inr", { precision: 18, scale: 2 }).notNull(),
    /** ECB publication date of `exchangeRate`; null for INR. */
    rateDate: date("rate_date"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("benchmark_prices_combo_date_uidx").on(
      table.benchmarkMaterialLocationId,
      table.benchmarkDate,
    ),
    index("benchmark_prices_benchmark_date_idx").on(table.benchmarkDate),
    index("benchmark_prices_combo_date_desc_idx").on(
      table.benchmarkMaterialLocationId,
      table.benchmarkDate,
    ),
  ],
);

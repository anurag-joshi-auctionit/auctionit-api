import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { benchmarkLocations } from "./benchmark-locations.js";
import { benchmarkMaterials } from "./benchmark-materials.js";
import { users } from "./users.js";

export const BENCHMARK_CURRENCIES = ["INR", "USD"] as const;
export type BenchmarkCurrency = (typeof BENCHMARK_CURRENCIES)[number];
export const BENCHMARK_BASE_CURRENCY: BenchmarkCurrency = "INR";

export const benchmarkMaterialLocations = pgTable(
  "benchmark_material_locations",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    materialId: integer("material_id")
      .notNull()
      .references(() => benchmarkMaterials.id),
    locationId: integer("location_id")
      .notNull()
      .references(() => benchmarkLocations.id),
    currency: varchar("currency", { length: 3 })
      .$type<BenchmarkCurrency>()
      .notNull()
      .default("INR"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("benchmark_material_locations_material_id_location_id_uidx").on(
      table.materialId,
      table.locationId,
    ),
    index("benchmark_material_locations_is_active_idx").on(table.isActive),
    index("benchmark_material_locations_location_id_idx").on(table.locationId),
  ],
);

import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { benchmarkMaterials } from "./benchmark-materials.js";
import { clients } from "./clients.js";
import { materials } from "./materials.js";
import { uoms } from "./uoms.js";
import { users } from "./users.js";

export const items = pgTable(
  "items",
  {
    id: integer("id").primaryKey().notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    name: varchar("name", { length: 1000 }),
    isActive: boolean("is_active").notNull(),
    materialId: integer("material_id").references(() => materials.id),
    benchmarkMaterialId: integer("benchmark_material_id").references(
      () => benchmarkMaterials.id,
    ),
    uomId: smallint("uom_id").references(() => uoms.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    index("items_client_id_idx").on(table.clientId),
    index("items_material_id_idx").on(table.materialId),
    index("items_benchmark_material_id_idx").on(table.benchmarkMaterialId),
    index("items_client_id_is_active_idx").on(table.clientId, table.isActive),
  ],
);

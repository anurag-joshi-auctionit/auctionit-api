import { sql } from "drizzle-orm";
import {
    boolean,
    check,
    index,
    integer,
    pgTable,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";
import { clients } from "./clients.js";
import { locations } from "./locations.js";
import { users } from "./users.js";

export const materialLocations = pgTable(
    "material_locations",
    {
        id: integer("id").primaryKey().notNull(),
        clientId: integer("client_id")
            .notNull()
            .references(() => clients.id),
        name: varchar("name", { length: 100 }),
        country: varchar("country", { length: 100 }),
        state: varchar("state", { length: 100 }),
        city: varchar("city", { length: 100 }),
        locationId: integer("location_id").references(() => locations.id),
        pincode: varchar("pincode", { length: 6 }),
        isActive: boolean("is_active").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
        createdBy: integer("created_by").references(() => users.id),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
        updatedBy: integer("updated_by").references(() => users.id),
    },
    (table) => [
        index("material_locations_client_id_idx").on(table.clientId),
        index("material_locations_location_id_idx").on(table.locationId),
        check(
            "material_locations_pincode_format",
            sql`${table.pincode} IS NULL OR ${table.pincode} ~ '^[0-9]{6}$'`,
        ),
    ],
);

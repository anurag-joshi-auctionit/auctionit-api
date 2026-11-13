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

export const plantLocations = pgTable(
    "plant_locations",
    {
        id: integer("id").primaryKey().notNull(),
        clientId: integer("client_id")
            .notNull()
            .references(() => clients.id),
        name: varchar("name", { length: 100 }),
        address: varchar("address", { length: 300 }),
        country: varchar("country", { length: 100 }),
        state: varchar("state", { length: 100 }),
        city: varchar("city", { length: 100 }),
        locationId: integer("location_id").references(() => locations.id),
        pincode: varchar("pincode", { length: 6 }),
        isActive: boolean("is_active").notNull(),
        pocName: varchar("poc_name", { length: 200 }),
        pocEmail: varchar("poc_email", { length: 200 }),
        pocPhone: varchar("poc_phone", { length: 100 }),
        billingName: varchar("billing_name", { length: 200 }),
        billingEmailTo: varchar("billing_email_to", { length: 300 }),
        billingEmailCc: varchar("billing_email_cc", { length: 500 }),
        gracePeriod: integer("grace_period"),
        gstin: varchar("gstin", { length: 15 }),
        pan: varchar("pan", { length: 10 }),
        orderNumber: varchar("order_number", { length: 100 }),
        orderDate: timestamp("order_date", { withTimezone: true, mode: "string" }),
        kamId: integer("kam_id").references(() => users.id),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
        createdBy: integer("created_by").references(() => users.id),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
        updatedBy: integer("updated_by").references(() => users.id),
    },
    (table) => [
        index("plant_locations_client_id_idx").on(table.clientId),
        index("plant_locations_kam_id_idx").on(table.kamId),
        index("plant_locations_location_id_idx").on(table.locationId),
        check(
            "plant_locations_pincode_format",
            sql`${table.pincode} IS NULL OR ${table.pincode} ~ '^[0-9]{6}$'`,
        ),
        check(
            "plant_locations_pan_format",
            sql`${table.pan} IS NULL OR ${table.pan} ~* '^[A-Z]{5}[0-9]{4}[A-Z]$'`,
        ),
        check(
            "plant_locations_gstin_format",
            sql`${table.gstin} IS NULL OR ${table.gstin} ~* '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`,
        ),
    ],
);

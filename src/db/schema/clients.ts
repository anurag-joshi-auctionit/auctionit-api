import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { SERVICE_FEE_TYPES } from "@auctionit/messages/clients";
import { locations } from "./locations.js";
import { users } from "./users.js";

export const serviceFeeTypeEnum = pgEnum("service_fee_type", SERVICE_FEE_TYPES);

export const clients = pgTable(
  "clients",
  {
    //identity
    id: integer("id").primaryKey().notNull(),
    companyName: varchar("company_name", { length: 100 }).notNull(),

    //address
    address: varchar("address", { length: 200 }),
    locationId: integer("location_id").references(() => locations.id),
    pincode: varchar("pincode", { length: 6 }),

    //tax
    pan: varchar({ length: 10 }),
    tan: varchar({ length: 10 }),
    gstin: varchar({ length: 15 }),

    //materials (references materials master ids)
    materials: integer("materials").array().notNull().default([]),

    // standing client→bidder map (references bidders.id) — set, no duplicates
    bidders: integer("bidders").array().notNull().default([]),

    //status flags
    isActive: boolean("is_active").notNull(),

    //contact
    phone: varchar("phone", { length: 20 }),
    website: varchar("website", { length: 100 }),
    email: varchar("email", { length: 100 }),

    auctionPrefix: varchar("auction_prefix", { length: 30 }),
    serviceFeeType: serviceFeeTypeEnum("service_fee_type")
      .notNull()
      .default("service_percentage"),
    serviceFeeValue: numeric("service_fee_value", {
      precision: 18,
      scale: 4,
      mode: "number",
    }).notNull(),
    isLastBidExtension: boolean("is_last_bid_extension").notNull(),
    lastBidExtensionWindow: smallint("last_bid_extension_window")
      .notNull()
      .default(0),
    lastBidExtensionInterval: smallint("last_bid_extension_interval")
      .notNull()
      .default(0),
    lastBidExtensionCountMax: smallint("last_bid_extension_count_max")
      .notNull()
      .default(0),
    /** Lot staggering master gate. Authoritative — never derived from the interval. */
    isStaggered: boolean("is_staggered").notNull().default(false),
    /** Seconds between staggered lot ends; must be > 0 when isStaggered. */
    staggerInterval: smallint("stagger_interval").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    check(
      "clients_pincode_format",
      sql`${table.pincode} IS NULL OR ${table.pincode} ~ '^[0-9]{6}$'`,
    ),
    check(
      "clients_pan_format",
      sql`${table.pan} IS NULL OR ${table.pan} ~* '^[A-Z]{5}[0-9]{4}[A-Z]$'`,
    ),
    check(
      "clients_tan_format",
      sql`${table.tan} IS NULL OR ${table.tan} ~* '^[A-Z]{4}[0-9]{5}[A-Z]$'`,
    ),
    check(
      "clients_gstin_format",
      sql`${table.gstin} IS NULL OR ${table.gstin} ~* '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`,
    ),
    check(
      "clients_service_fee_value_positive",
      sql`${table.serviceFeeValue} >= 0`,
    ),
    check(
      "clients_service_fee_percentage_range",
      sql`${table.serviceFeeType} <> 'service_percentage' OR (${table.serviceFeeValue} >= 0 AND ${table.serviceFeeValue} <= 5)`,
    ),
    check(
      "clients_stagger_interval_required",
      sql`NOT ${table.isStaggered} OR ${table.staggerInterval} > 0`,
    ),
    index("clients_bidders_gin").using("gin", table.bidders),
  ],
);

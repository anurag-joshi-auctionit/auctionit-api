import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { locations } from "./locations.js";
import { users } from "./users.js";

export const bidders = pgTable(
  "bidders",
  {
    //identity
    id: integer("id").primaryKey().notNull(),
    companyName: varchar("company_name", { length: 100 }).notNull(),

    //address
    address: varchar("address", { length: 1000 }),
    locationId: integer("location_id").references(() => locations.id),
    country: varchar("country", { length: 100 }),
    state: varchar("state", { length: 100 }),
    city: varchar("city", { length: 100 }),
    pincode: varchar("pincode", { length: 6 }),

    website: varchar("website", { length: 100 }),

    //tax
    pan: varchar({ length: 10 }),
    gstin: varchar({ length: 15 }),

    //materials (references materials master ids)
    materials: integer("materials").array().notNull().default([]),

    //status flags
    isActive: boolean("is_active").notNull(),
    isVerified: boolean("is_verified").notNull().default(false),

    //validity
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "string" }),
    validTo: timestamp("valid_to", { withTimezone: true, mode: "string" }),

    /** Virtual account number for EMD deposits: `ICOM` + bidder id. */
    van: varchar("van", { length: 16 }).unique(),

    //EMD balance caches, written only by the EMD ledger writer
    emdAvailableBalance: numeric("emd_available_balance", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    emdBlockedBalance: numeric("emd_blocked_balance", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    /** Deprecated: no longer written. Held money is part of `emd_blocked_balance`. */
    emdWinningBalance: numeric("emd_winning_balance", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),

    //audit
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    createdBy: integer("created_by").references(() => users.id),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    check(
      "bidders_pincode_format",
      sql`${table.pincode} IS NULL OR ${table.pincode} ~ '^[0-9]{6}$'`,
    ),
    check(
      "bidders_pan_format",
      sql`${table.pan} IS NULL OR ${table.pan} ~* '^[A-Z]{5}[0-9]{4}[A-Z]$'`,
    ),
    check(
      "bidders_gstin_format",
      sql`${table.gstin} IS NULL OR ${table.gstin} ~* '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`,
    ),
    // emd_available_balance can go negative for a few legacy ledgers, so it
    // has no non-negative check.
  ],
);

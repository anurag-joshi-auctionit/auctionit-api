import { boolean, integer, pgTable, serial, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** Why a winning EMD is forfeited; picked when raising a forfeiture request. */
export const emdForfeitureDispositions = pgTable("emd_forfeiture_dispositions", {
  id: serial("id").primaryKey().notNull(),
  label: varchar("label", { length: 128 }).notNull(),
  description: varchar("description", { length: 500 }).notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by").references(() => users.id),
});

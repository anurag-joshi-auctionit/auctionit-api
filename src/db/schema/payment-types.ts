import { boolean, integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Payment mode catalog (port of legacy tbl_Config_PaymentType).
// Shared by subscription ledger rows and EMD deposit UI (ids 1/2/4).
export const paymentTypes = pgTable("payment_types", {
  id: integer("id").primaryKey().notNull(),
  name: varchar("name", { length: 50 }).notNull(),
  /** Bank account number; the EMD statement import uses it to detect the account. */
  accountNumber: varchar("account_number", { length: 30 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
  createdBy: integer("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by").references(() => users.id),
});

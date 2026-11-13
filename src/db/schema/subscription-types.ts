import {
  boolean,
  integer,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Subscription plan catalog (port of legacy tbl_Config_SubscriptionType).
// `months` drives the validity window for each plan.
// `amount` is the plan's list price (inclusive of GST); `gstPercent` is
// used to split an entered amount into ex-GST price + GST.
export const subscriptionTypes = pgTable("subscription_types", {
  id: integer("id").primaryKey().notNull(),
  name: varchar("name", { length: 50 }).notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull().default("0"),
  gstPercent: numeric("gst_percent", { precision: 5, scale: 2 })
    .notNull()
    .default("0"),
  months: integer("months"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by").references(() => users.id),
});

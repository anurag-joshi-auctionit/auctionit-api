import {
  boolean,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** First module-registered id range starts at 1000 (legacy NotificationIds stay below). */
export const NOTIFICATION_TYPE_SERVICE_INVOICE_ANNEXURE = 1000;
export const NOTIFICATION_TYPE_SUBSCRIPTION_ANNEXURE = 1001;
export const NOTIFICATION_TYPE_ADHOC_SEND = 1002;
export const NOTIFICATION_TYPE_LOT_CONFIRMATION = 1003;
export const NOTIFICATION_TYPE_CATALOGUE_NOTIFICATION = 1004;
export const NOTIFICATION_TYPE_SUBSCRIPTION_PAYMENT_LINK = 1005;
export const NOTIFICATION_TYPE_EMD_FORFEITED = 1006;

/** Legacy EmailNotification worker ids (kept for parity / backfill). */
export const NOTIFICATION_TYPE_AUCTION_ABOUT_TO_START = 3;
export const NOTIFICATION_TYPE_AUCTION_CONCLUDED = 5;
export const NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_BEFORE_DUE = 90;
export const NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_AFTER_DUE = 91;

export const notificationTypes = pgTable("notification_types", {
  id: integer("id").primaryKey().notNull(),
  description: varchar("description", { length: 100 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  createdBy: integer("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by").references(() => users.id),
});

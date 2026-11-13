import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { clients } from "./clients.js";
import { users } from "./users.js";

export const CATALOGUE_NOTIFICATION_TYPES = ["new", "revised"] as const;
export type CatalogueNotificationType =
  (typeof CATALOGUE_NOTIFICATION_TYPES)[number];

export const catalogueNotificationTypeEnum = pgEnum(
  "catalogue_notification_type",
  CATALOGUE_NOTIFICATION_TYPES,
);

/**
 * Batch-level audit for catalogue notification sends (one row per Send Catalogue).
 * Per-recipient delivery lives in `notification_email_logs` with
 * sourceType = auction_catalogue_notification.
 */
export const auctionCatalogueNotifications = pgTable(
  "auction_catalogue_notifications",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    catalogueType: catalogueNotificationTypeEnum("catalogue_type").notNull(),
    materialsSummary: varchar("materials_summary", { length: 300 }).notNull(),
    additionalInfo: text("additional_info"),
    reasonForRevision: text("reason_for_revision"),
    kamContact: varchar("kam_contact", { length: 200 }),
    plantLocationsSummary: varchar("plant_locations_summary", {
      length: 500,
    }).notNull(),
    subject: varchar("subject", { length: 250 }).notNull(),
    emailBody: text("email_body").notNull(),
    recipientCount: integer("recipient_count").notNull().default(0),
    sentBy: integer("sent_by")
      .notNull()
      .references(() => users.id),
    /** When the admin triggered the batch (enqueue time), not SMTP delivery. */
    triggeredAt: timestamp("triggered_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
);

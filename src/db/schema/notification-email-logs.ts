import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
  index,
} from "drizzle-orm/pg-core";
import { notificationTypes } from "./notification-types.js";
import { users } from "./users.js";

export const NOTIFICATION_EMAIL_STATUSES = [
  "queued",
  "sending",
  "sent",
  "failed",
] as const;

export type NotificationEmailStatus =
  (typeof NOTIFICATION_EMAIL_STATUSES)[number];

/** Correlates an outbox row back to the domain entity that triggered send. */
export const EMAIL_SOURCE_TYPE_SERVICE_INVOICE = "service_invoice" as const;
export const EMAIL_SOURCE_TYPE_SUBSCRIPTION = "subscription" as const;
export const EMAIL_SOURCE_TYPE_SUBSCRIPTION_PAYMENT_LINK =
  "subscription_payment_link" as const;
export const EMAIL_SOURCE_TYPE_LOT_CONFIRMATION = "lot_confirmation" as const;
export const EMAIL_SOURCE_TYPE_AUCTION = "auction" as const;
export const EMAIL_SOURCE_TYPE_AUCTION_CATALOGUE_NOTIFICATION =
  "auction_catalogue_notification" as const;
export const EMAIL_SOURCE_TYPE_EMD_FORFEITURE = "emd_forfeiture" as const;
export const EMAIL_SOURCE_TYPE_BANK_CHANGE_REQUEST =
  "bank_change_request" as const;

/** R2 reference persisted on the log row — bytes are fetched at send time. */
export type EmailAttachmentRef = {
  s3Key: string;
  filename: string;
  contentType: string;
};

/**
 * Active outbox + permanent audit log. Backfill preserves legacy
 * `tbl_Data_EmailNotificationLog.Id` as `id`; new rows use identity.
 */
export const notificationEmailLogs = pgTable(
  "notification_email_logs",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    auctionId: integer("auction_id"),
    notificationId: integer("notification_id")
      .notNull()
      .references(() => notificationTypes.id),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    emailTo: text("email_to").notNull(),
    emailCc: text("email_cc"),
    emailBcc: text("email_bcc"),
    emailBody: text("email_body").notNull(),
    subject: text("subject").notNull().default(""),
    attachments: jsonb("attachments").$type<EmailAttachmentRef[] | null>(),
    requiresAttachment: boolean("requires_attachment").notNull().default(false),
    /** e.g. `service_invoice` — used by the worker to stamp domain audit columns. */
    sourceType: varchar("source_type", { length: 50 }),
    sourceId: integer("source_id"),
    enqueuedBy: integer("enqueued_by").references(() => users.id),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("notification_email_logs_pending_idx").on(t.status, t.nextAttemptAt),
    index("notification_email_logs_auction_id_idx").on(t.auctionId),
    index("notification_email_logs_notification_id_idx").on(t.notificationId),
    index("notification_email_logs_source_idx").on(t.sourceType, t.sourceId),
  ],
);

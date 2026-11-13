import {
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { paymentTypes } from "./payment-types.js";
import { subscriptionTypes } from "./subscription-types.js";
import { users } from "./users.js";

// Subscription payment ledger (port of legacy tbl_Data_PaymentTransaction).
// One row per paid period. A bidder is subscribed when a non-cancelled row
// exists with from_date <= today and to_date >= today. Active cover status is
// derived, never stored. Invoice lifecycle meta is stored on the row; PDF files
// live in subscription_documents.
// `id` preserves MSSQL PaymentId (BY DEFAULT identity for live inserts).

export const SUBSCRIPTION_INVOICE_STATUSES = [
  "requested",
  "recheck",
  "generated",
  "cancelled",
] as const;
export type SubscriptionInvoiceStatus =
  (typeof SUBSCRIPTION_INVOICE_STATUSES)[number];

export const subscriptionInvoiceStatusEnum = pgEnum(
  "subscription_invoice_status",
  SUBSCRIPTION_INVOICE_STATUSES,
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    subscriptionTypeId: integer("subscription_type_id")
      .notNull()
      .references(() => subscriptionTypes.id),

    fromDate: date("from_date", { mode: "string" }),
    toDate: date("to_date", { mode: "string" }),

    subscriptionPrice: numeric("subscription_price", {
      precision: 18,
      scale: 2,
    })
      .notNull()
      .default("0"),
    gstAmount: numeric("gst_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    amount: numeric("amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),

    paymentMode: integer("payment_mode").references(() => paymentTypes.id),
    transactionId: varchar("transaction_id", { length: 100 }),
    paymentDate: date("payment_date", { mode: "string" }),
    remarks: varchar("remarks", { length: 2000 }),

    invoiceStatus: subscriptionInvoiceStatusEnum("invoice_status")
      .notNull()
      .default("requested"),
    invoiceNumber: varchar("invoice_number", { length: 30 }),
    invoiceDate: date("invoice_date", { mode: "string" }),
    invoiceRequestedAt: timestamp("invoice_requested_at", { withTimezone: true, mode: "string" }),
    invoiceRequestedBy: integer("invoice_requested_by").references(
      () => users.id,
    ),
    invoiceGeneratedAt: timestamp("invoice_generated_at", { withTimezone: true, mode: "string" }),
    invoiceGeneratedBy: integer("invoice_generated_by").references(
      () => users.id,
    ),
    invoiceRecheckedAt: timestamp("invoice_rechecked_at", { withTimezone: true, mode: "string" }),
    invoiceRecheckedBy: integer("invoice_rechecked_by").references(
      () => users.id,
    ),
    invoiceCancelledAt: timestamp("invoice_cancelled_at", { withTimezone: true, mode: "string" }),
    invoiceCancelledBy: integer("invoice_cancelled_by").references(
      () => users.id,
    ),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true, mode: "string" }),
    emailSentBy: integer("email_sent_by").references(() => users.id),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("subscriptions_invoice_number_uidx").on(table.invoiceNumber),
    index("subscriptions_bidder_id_idx").on(table.bidderId),
    index("subscriptions_subscription_type_id_idx").on(
      table.subscriptionTypeId,
    ),
  ],
);

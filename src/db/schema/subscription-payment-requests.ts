import {
  integer,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { subscriptions } from "./subscriptions.js";
import { subscriptionTypes } from "./subscription-types.js";
import { users } from "./users.js";

// One row per subscription payment attempt via Instamojo (port of legacy
// tbl_Data_OnlinePaymentRequestLog). `merchant_txn_id` is our own reference
// sent to Instamojo as `transaction_id` and used to poll the order status.
// `status` moves requested → completed | failed; on completion the created
// ledger row is linked via `subscription_id`.
// `id` preserves MSSQL id (BY DEFAULT identity for live inserts).
export const subscriptionPaymentRequests = pgTable(
  "subscription_payment_requests",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    subscriptionTypeId: integer("subscription_type_id")
      .notNull()
      .references(() => subscriptionTypes.id),
    merchantTxnId: varchar("merchant_txn_id", { length: 100 })
      .notNull()
      .unique(),
    orderId: varchar("order_id", { length: 100 }),
    paymentUrl: varchar("payment_url", { length: 1000 }),
    amount: numeric("amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    // requested | completed | failed
    status: varchar("status", { length: 20 }).notNull().default("requested"),
    message: varchar("message", { length: 500 }),
    instamojoPaymentId: varchar("instamojo_payment_id", { length: 100 }),
    subscriptionId: integer("subscription_id").references(
      () => subscriptions.id,
    ),
    // bidder = self-service checkout; admin = payment link emailed from admin
    source: varchar("source", { length: 20 }).notNull().default("bidder"),
    initiatedByUserId: integer("initiated_by_user_id").references(
      () => users.id,
    ),
    emailQueuedAt: timestamp("email_queued_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  },
);

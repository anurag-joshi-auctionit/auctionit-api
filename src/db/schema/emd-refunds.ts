import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

/** `requested` → admin review → `reviewed` → accounts verify → `verified` → `paid`. */
export const EMD_REFUND_STATUSES = [
  "requested",
  "reviewed",
  "verified",
  "paid",
  "rejected",
  "cancelled",
] as const;
export type EmdRefundStatus = (typeof EMD_REFUND_STATUSES)[number];

/** Statuses whose amount is still held by iCom (debited, not yet paid out). */
export const EMD_REFUND_OPEN_STATUSES = [
  "requested",
  "reviewed",
  "verified",
] as const satisfies readonly EmdRefundStatus[];

export const emdRefundStatusEnum = pgEnum(
  "emd_refund_status",
  EMD_REFUND_STATUSES,
);

/**
 * Who rejected a request. Not stored: an accounts rejection sets `verified_*`,
 * an admin rejection only `reviewed_*`.
 */
export const EMD_REFUND_REJECTION_STAGES = ["admin", "accounts"] as const;
export type EmdRefundRejectionStage =
  (typeof EMD_REFUND_REJECTION_STAGES)[number];

/**
 * Bidder EMD refund requests: status workflow only. The money moves in
 * `emd_transactions` (`refund_requested` debit, `refund_rejected` /
 * `refund_cancelled` credit). Bank details are read from
 * `bidder_bank_accounts`, not copied here. Legacy PayId is kept as `id` on seed.
 */
export const emdRefunds = pgTable(
  "emd_refunds",
  {
    //identity
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),

    //request (bidder)
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    status: emdRefundStatusEnum("status").notNull().default("requested"),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    requestedBy: integer("requested_by")
      .notNull()
      .references(() => users.id),
    requestedRemarks: varchar("requested_remarks", { length: 500 }),

    //level 1: admin review
    reviewedAt: timestamp("reviewed_at", {
      withTimezone: true,
      mode: "string",
    }),
    reviewedBy: integer("reviewed_by").references(() => users.id),
    reviewedRemarks: varchar("reviewed_remarks", { length: 500 }),

    //level 2: accounts verification
    verifiedAt: timestamp("verified_at", {
      withTimezone: true,
      mode: "string",
    }),
    verifiedBy: integer("verified_by").references(() => users.id),
    verifiedRemarks: varchar("verified_remarks", { length: 500 }),

    //payout (entered by accounts)
    txnRefNo: varchar("txn_ref_no", { length: 100 }),
    paymentDate: date("payment_date", { mode: "string" }),
    paymentRemarks: varchar("payment_remarks", { length: 500 }),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    paidBy: integer("paid_by").references(() => users.id),

    //cancellation (bidder, before verification)
    cancelledAt: timestamp("cancelled_at", {
      withTimezone: true,
      mode: "string",
    }),
    cancelledBy: integer("cancelled_by").references(() => users.id),

    //audit (creation is requested_at / requested_by)
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [
    check("emd_refunds_amount_positive", sql`${t.amount} > 0`),
    index("emd_refunds_bidder_id_status_idx").on(t.bidderId, t.status),
    index("emd_refunds_status_requested_at_idx").on(t.status, t.requestedAt),
  ],
);

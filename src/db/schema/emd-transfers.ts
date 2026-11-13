import { sql } from "drizzle-orm";
import {
  check,
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

/** `requested` → HOD review → `approved` | `rejected`. */
export const EMD_TRANSFER_STATUSES = ["requested", "approved", "rejected"] as const;
export type EmdTransferStatus = (typeof EMD_TRANSFER_STATUSES)[number];

export const emdTransferStatusEnum = pgEnum("emd_transfer_status", EMD_TRANSFER_STATUSES);

/**
 * Moves withdrawable EMD from one bidder's wallet to another: status workflow
 * only. Nothing is posted until approval, which writes both ledger legs at once
 * (`transfer_out` debit on the source, `transfer_in` credit on the target).
 * A pending row therefore holds no money, so the balance is re-checked at
 * review time.
 */
export const emdTransfers = pgTable(
  "emd_transfers",
  {
    //identity
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),

    //target
    fromBidderId: integer("from_bidder_id")
      .notNull()
      .references(() => bidders.id),
    toBidderId: integer("to_bidder_id")
      .notNull()
      .references(() => bidders.id),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),

    status: emdTransferStatusEnum("status").notNull().default("requested"),

    //workflow
    requestedBy: integer("requested_by")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    requestedRemarks: varchar("requested_remarks", { length: 500 }).notNull(),
    reviewedBy: integer("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewedRemarks: varchar("reviewed_remarks", { length: 500 }),

    //audit (creation is requested_at / requested_by)
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [
    check("emd_transfers_amount_positive", sql`${t.amount} > 0`),
    check("emd_transfers_distinct_bidders", sql`${t.fromBidderId} <> ${t.toBidderId}`),
    index("emd_transfers_status_requested_at_idx").on(t.status, t.requestedAt),
    index("emd_transfers_from_bidder_id_idx").on(t.fromBidderId),
    index("emd_transfers_to_bidder_id_idx").on(t.toBidderId),
  ],
);

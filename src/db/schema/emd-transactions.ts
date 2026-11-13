import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { auctionLotEmdRanges } from "./auction-lot-emd-ranges.js";
import { auctions } from "./auctions.js";
import { bidders } from "./bidders.js";
import { emdForfeitures } from "./emd-forfeitures.js";
import { emdRefunds } from "./emd-refunds.js";
import { emdTransfers } from "./emd-transfers.js";
import { paymentTypes } from "./payment-types.js";
import { users } from "./users.js";

export const EMD_TYPES = [
  "emd_deposit",
  "opening_balance",
  "correction_credit",
  "correction_debit",
  "blocked_bidder_attached",
  "blocked_winning",
  "release_auction_closed",
  "release_bidder_detached",
  "release_lot_withdrawn",
  "release_bidder_unverified",
  "release_by_admin",
  "release_lot_rejected",
  "refund_requested",
  "refund_processed",
  "refund_rejected",
  "refund_cancelled",
  // Append new values here: a value added mid-list makes Drizzle drop and
  // recreate the enum, which rewrites the whole emd_transactions table.
  "release_block_revised",
  "transfer_out",
  "transfer_in",
  "release_winning_by_admin",
  "blocked_winning_correction",
  "release_winning_correction",
] as const;
export type EmdType = (typeof EMD_TYPES)[number];

export const EMD_TXN_TYPES = ["credit", "debit"] as const;
export type EmdTxnType = (typeof EMD_TXN_TYPES)[number];

/** Accounting side of every EMD type. The ledger writer sets txn_type from it. */
export const EMD_TYPE_TXN_TYPE: Record<EmdType, EmdTxnType> = {
  emd_deposit: "credit",
  opening_balance: "credit",
  correction_credit: "credit",
  correction_debit: "debit",
  blocked_bidder_attached: "debit",
  blocked_winning: "debit",
  release_auction_closed: "credit",
  release_bidder_detached: "credit",
  release_lot_withdrawn: "credit",
  release_bidder_unverified: "credit",
  release_by_admin: "credit",
  release_lot_rejected: "credit",
  release_block_revised: "credit",
  refund_requested: "debit",
  refund_processed: "debit",
  refund_rejected: "credit",
  refund_cancelled: "credit",
  transfer_out: "debit",
  transfer_in: "credit",
  release_winning_by_admin: "credit",
  blocked_winning_correction: "debit",
  release_winning_correction: "credit",
};

export const EMD_BLOCK_STATUSES = ["exception", "full", "partial"] as const;
export type EmdBlockStatus = (typeof EMD_BLOCK_STATUSES)[number];

export const emdTypeEnum = pgEnum("emd_type", EMD_TYPES);
export const emdTxnTypeEnum = pgEnum("emd_txn_type", EMD_TXN_TYPES);
export const emdBlockStatusEnum = pgEnum("emd_block_status", EMD_BLOCK_STATUSES);

const typesOf = (side: EmdTxnType) =>
  sql.raw(
    EMD_TYPES.filter((t) => EMD_TYPE_TXN_TYPE[t] === side)
      .map((t) => `'${t}'`)
      .join(", "),
  );

/**
 * Append-only EMD ledger: every movement of a bidder's EMD, in or out of the
 * portal and between Available and Blocked. Available balance is
 * credits minus debits. Legacy TrnId is kept as `id` on seed.
 */
export const emdTransactions = pgTable(
  "emd_transactions",
  {
    //identity
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    emdType: emdTypeEnum("emd_type").notNull(),
    txnType: emdTxnTypeEnum("txn_type").notNull(),

    //amount (always positive; txn_type gives the direction)
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),

    //links
    auctionId: integer("auction_id").references(() => auctions.id),
    emdRangeId: integer("emd_range_id").references(() => auctionLotEmdRanges.id),
    refundId: integer("refund_id").references(() => emdRefunds.id),
    forfeitureId: integer("forfeiture_id").references(() => emdForfeitures.id),
    transferId: integer("transfer_id").references(() => emdTransfers.id),
    reversesTransactionId: integer("reverses_transaction_id").references(
      (): AnyPgColumn => emdTransactions.id,
    ),

    //payment / bank details (credits; txnRefNo also on refund payouts)
    paymentTypeId: integer("payment_type_id").references(() => paymentTypes.id),
    bankTransactionId: varchar("bank_transaction_id", { length: 100 }),
    txnRefNo: varchar("txn_ref_no", { length: 100 }),
    bankDescription: varchar("bank_description", { length: 500 }),
    valueDate: timestamp("value_date", { withTimezone: true, mode: "string" }),
    remitterName: varchar("remitter_name", { length: 200 }),
    remitterAccount: varchar("remitter_account", { length: 50 }),
    remitterIfsc: varchar("remitter_ifsc", { length: 20 }),
    importBatchId: uuid("import_batch_id"),

    //block details
    blockStatus: emdBlockStatusEnum("block_status"),
    winningLotIds: integer("winning_lot_ids").array(),
    blockLotIds: integer("block_lot_ids").array(),
    reference: varchar("reference", { length: 200 }),

    //text
    narration: varchar("narration", { length: 500 }).notNull(),
    remarks: varchar("remarks", { length: 500 }),

    //audit (append-only: no updated_*)
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    check("emd_transactions_amount_positive", sql`${t.amount} > 0`),
    check(
      "emd_transactions_txn_type_matches_emd_type",
      sql`(${t.txnType} = 'credit' AND ${t.emdType} IN (${typesOf("credit")})) OR (${t.txnType} = 'debit' AND ${t.emdType} IN (${typesOf("debit")}))`,
    ),
    index("emd_transactions_bidder_id_id_idx").on(t.bidderId, t.id),
    index("emd_transactions_bidder_id_created_at_idx").on(t.bidderId, t.createdAt, t.id),
    index("emd_transactions_created_at_idx").on(t.createdAt, t.id),
    index("emd_transactions_auction_id_bidder_id_idx").on(t.auctionId, t.bidderId),
    index("emd_transactions_refund_id_idx").on(t.refundId),
    index("emd_transactions_remitter_account_idx").on(t.remitterAccount),
    uniqueIndex("emd_transactions_payment_type_bank_txn_unique")
      .on(t.paymentTypeId, t.bankTransactionId)
      .where(sql`${t.bankTransactionId} IS NOT NULL`),
    uniqueIndex("emd_transactions_reverses_transaction_id_unique")
      .on(t.reversesTransactionId)
      .where(sql`${t.reversesTransactionId} IS NOT NULL`),
  ],
);

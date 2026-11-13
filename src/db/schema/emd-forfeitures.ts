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
  varchar,
} from "drizzle-orm/pg-core";
import { auctionLotEmdRanges } from "./auction-lot-emd-ranges.js";
import { auctions } from "./auctions.js";
import { bidders } from "./bidders.js";
import { emdForfeitureDispositions } from "./emd-forfeiture-dispositions.js";
import { files } from "./files.js";
import { users } from "./users.js";

/** `requested` → HOD review → `forfeited` | `rejected`. */
export const EMD_FORFEITURE_STATUSES = [
  "requested",
  "forfeited",
  "rejected",
] as const;
export type EmdForfeitureStatus = (typeof EMD_FORFEITURE_STATUSES)[number];

export const emdForfeitureStatusEnum = pgEnum(
  "emd_forfeiture_status",
  EMD_FORFEITURE_STATUSES,
);

/**
 * Forfeiture of a bidder's blocked EMD for one range. HOD approval moves the
 * status to `forfeited` immediately; no ledger entry is posted because the
 * money already left Available when it was blocked. A forfeited row is
 * payable to the client until `paid_to_client_at` is set. The client comes
 * from the auction; the bidder email is tracked in `notification_email_logs`.
 */
export const emdForfeitures = pgTable(
  "emd_forfeitures",
  {
    //identity
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),

    //target
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    emdRangeId: integer("emd_range_id").references(() => auctionLotEmdRanges.id),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),

    //reason
    dispositionId: integer("disposition_id").references(() => emdForfeitureDispositions.id),
    requestedRemarks: varchar("requested_remarks", { length: 500 }),
    attachmentFileId: integer("attachment_file_id").references(() => files.id),

    status: emdForfeitureStatusEnum("status").notNull().default("requested"),

    //workflow
    requestedBy: integer("requested_by")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    reviewedBy: integer("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewedRemarks: varchar("reviewed_remarks", { length: 500 }),

    //payment to client
    clientTxnRefNo: varchar("client_txn_ref_no", { length: 100 }),
    paidToClientBy: integer("paid_to_client_by").references(() => users.id),
    paidToClientAt: timestamp("paid_to_client_at", { withTimezone: true, mode: "string" }),

    //audit (creation is requested_at / requested_by)
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [
    check("emd_forfeitures_amount_positive", sql`${t.amount} > 0`),
    uniqueIndex("emd_forfeitures_open_target_unique")
      .on(t.auctionId, t.bidderId, sql`coalesce(${t.emdRangeId}, 0)`)
      .where(sql`${t.status} <> 'rejected'`),
    index("emd_forfeitures_bidder_id_idx").on(t.bidderId),
    index("emd_forfeitures_status_idx").on(t.status),
    index("emd_forfeitures_auction_id_idx").on(t.auctionId),
  ],
);

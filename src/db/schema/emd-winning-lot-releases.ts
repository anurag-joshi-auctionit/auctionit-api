import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { auctionLotEmdRanges } from "./auction-lot-emd-ranges.js";
import { auctionLots } from "./auction-lots.js";
import { auctions } from "./auctions.js";
import { bidders } from "./bidders.js";
import { emdTransactions } from "./emd-transactions.js";
import { users } from "./users.js";

/**
 * Admin release of one won lot's blocked EMD (EMD Release page). The EMD is
 * held per (auction, bidder, range) in `emd_range_holds`, so money moves only when the last pending
 * lot of the range is released: that release posts `release_winning_by_admin`
 * and `transaction_id` is set on every lot row the credit covers. Until then
 * the row is the only record of the release. Append-only audit trail.
 */
export const emdWinningLotReleases = pgTable(
  "emd_winning_lot_releases",
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
    lotId: integer("lot_id")
      .notNull()
      .references(() => auctionLots.id),
    emdRangeId: integer("emd_range_id").references(() => auctionLotEmdRanges.id),

    remarks: varchar("remarks", { length: 500 }).notNull(),

    //the range release; NULL while other lots of the range are pending
    transactionId: integer("transaction_id").references(() => emdTransactions.id),

    //audit (released by / at)
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex("emd_winning_lot_releases_bidder_lot_unique").on(t.bidderId, t.lotId),
    index("emd_winning_lot_releases_created_at_idx").on(t.createdAt, t.id),
    index("emd_winning_lot_releases_transaction_id_idx").on(t.transactionId),
  ],
);

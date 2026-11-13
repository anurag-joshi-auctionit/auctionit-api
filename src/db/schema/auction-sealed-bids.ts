import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { auctions } from "./auctions.js";
import { auctionLots } from "./auction-lots.js";
import { bidders } from "./bidders.js";
import { clients } from "./clients.js";
import { users } from "./users.js";

// Append-only ledger of sealed-bid window bids — kept apart from auction_bids
// (the live ledger). A bidder may bid many times; their latest row is their bid.
// Ties on amount go to the earliest created_at (clock_timestamp at insert).
export const auctionSealedBids = pgTable(
  "auction_sealed_bids",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    lotId: integer("lot_id")
      .notNull()
      .references(() => auctionLots.id),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    userId: integer("user_id").references(() => users.id),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .default(sql`clock_timestamp()`),
    // Soft-delete, set when the sealed-bid window is rescheduled while this
    // bid was still active — same shape as auction_bid_logs' removal columns.
    isRemoved: boolean("is_removed").notNull().default(false),
    removedAt: timestamp("removed_at", { withTimezone: true, mode: "string" }),
    removedBy: integer("removed_by").references(() => users.id),
  },
  (table) => [
    // Latest bid per bidder on a lot (DISTINCT ON lot, bidder ORDER BY created_at DESC).
    index("auction_sealed_bids_lot_bidder_created_idx").on(
      table.lotId,
      table.bidderId,
      table.createdAt.desc(),
    ),
    index("auction_sealed_bids_auction_lot_idx").on(
      table.auctionId,
      table.lotId,
    ),
  ],
);

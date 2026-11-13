import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { auctionLots } from "./auction-lots.js";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

// Append-only attempt audit for live bids (accepted + rejected). Mirrors legacy
// tbl_Data_AuctionTransaction_Log, with is_accepted / reject_reason for new
// engine writes. Seeded legacy rows leave those null (legacy had no status).
export const auctionBidLogs = pgTable(
  "auction_bid_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    lotId: integer("lot_id")
      .notNull()
      .references(() => auctionLots.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    isProxy: boolean("is_proxy").notNull().default(false),
    proxyAmount: numeric("proxy_amount", { precision: 18, scale: 2 }),
    ip: varchar("ip", { length: 64 }),
    // true/false for engine writes; null for seeded legacy (no status in source).
    isAccepted: boolean("is_accepted"),
    rejectReason: varchar("reject_reason", { length: 500 }),
    // Admin correction void — accepted attempts left in the audit with these set.
    isRemoved: boolean("is_removed").notNull().default(false),
    removedAt: timestamp("removed_at", { withTimezone: true, mode: "string" }),
    removedBy: integer("removed_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("auction_bid_logs_lot_id_created_at_idx").on(
      table.lotId,
      table.createdAt,
    ),
    index("auction_bid_logs_bidder_id_created_at_idx").on(
      table.bidderId,
      table.createdAt,
    ),
    // Rebuilding a lot's participant set after a correction needs the distinct
    // accepted bidders. Without this it walks the (lot_id, created_at) index and
    // hits the heap for every attempt row just to read is_accepted.
    index("auction_bid_logs_lot_accepted_bidder_idx")
      .on(table.lotId, table.bidderId)
      .where(sql`${table.isAccepted} = true`),
    // IP Address Restriction claimant lookup on the live bid path. Seeded legacy
    // rows store "<ip> | <device>", so the key is the bare IP.
    index("auction_bid_logs_auction_ip_idx")
      .on(table.auctionId, sql`btrim(split_part("ip", '|', 1))`)
      .where(sql`"ip" IS NOT NULL`),
  ],
);

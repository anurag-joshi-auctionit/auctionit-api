import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { auctionLots } from "./auction-lots.js";
import { auctions } from "./auctions.js";
import { bidders } from "./bidders.js";
import { clients } from "./clients.js";
import { users } from "./users.js";

export const auctionLotBidderMaps = pgTable(
  "auction_lot_bidder_maps",
  {
    id: integer("id").primaryKey().notNull(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    lotId: integer("lot_id").references(() => auctionLots.id),
    isEmdWithClient: boolean("is_emd_with_client").default(false),
    // Set when the auction close released this lot's EMD (not won); cleared when
    // the bidder is re-attached to the lot after a reopen.
    emdReleased: boolean("emd_released").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [
    // The bidder-facing queries (/auctions/me) filter by
    // bidder first. This table has ~8.3M rows (mostly per-lot maps), so without
    // this composite index those filters seq-scan (~1s); with it they are ~0.4ms.
    index("auction_lot_bidder_maps_bidder_auction_idx").on(
      t.bidderId,
      t.auctionId,
    ),
    // Live bid participant gate + lotBidders join on auction_id first.
    index("auction_lot_bidder_maps_auction_bidder_active_idx").on(
      t.auctionId,
      t.bidderId,
      t.isActive,
    ),
    // Client mapped-bidders tab aggregates active maps by client then bidder.
    index("auction_lot_bidder_maps_client_bidder_active_idx")
      .on(t.clientId, t.bidderId)
      .where(sql`${t.isActive} = true`),
    // One active per-lot map per bidder. Pool rows (lot_id IS NULL) are excluded.
    uniqueIndex("auction_lot_bidder_maps_active_lot_bidder_uidx")
      .on(t.auctionId, t.lotId, t.bidderId)
      .where(sql`${t.isActive} = true AND ${t.lotId} IS NOT NULL`),
  ],
);

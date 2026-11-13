import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { auctionLots } from "./auction-lots.js";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

// A bidder's standing maximum (proxy) bid for a lot: the ceiling the auto-bid
// engine will bid up to on their behalf. Port of legacy tbl_Data_ProxyAuctionAmount.
//
// One ACTIVE row per (lot, bidder). Raising the max deactivates the old row and
// inserts a new active one, so the ceiling history is preserved (matching the
// legacy IsActive=0 pattern). A max can only ever be raised, never lowered.
export const auctionProxyBids = pgTable("auction_proxy_bids", {
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
  // The ceiling the bidder authorizes; the engine never bids above this.
  maxAmount: numeric("max_amount", { precision: 18, scale: 2 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
}, (table) => [
  // The settlement reads active proxies for one lot on every bid.
  index("auction_proxy_bids_lot_active_idx").on(table.lotId, table.isActive),
  // Distinct armed bidders for a lot, for the participant rebuild after a
  // correction — index-only, no heap fetch to re-check is_active.
  index("auction_proxy_bids_lot_active_bidder_idx")
    .on(table.lotId, table.bidderId)
    .where(sql`${table.isActive} = true`),
]);

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

// Append-only ledger of accepted live bids. The lot's current winning amount is
// denormalized onto auction_lots.winning_amount / winner_*; this table is the
// per-bid history. Several rows may share an amount: earlier always wins, so a
// later bid that only matches an earlier commitment is recorded as losing.
export const auctionBids = pgTable("auction_bids", {
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
  // Yankee: per-bid quantity offered; null for FA/RA (lot quantity applies).
  quantity: numeric("quantity", { precision: 18, scale: 3 }),
  // Yankee: quantity allocated to this bid after settlement; null until Yankee engine lands.
  allocatedQuantity: numeric("allocated_quantity", { precision: 18, scale: 3 }),
  // True when this bid was placed automatically by the proxy (auto-bid) engine
  // rather than typed by the bidder. proxy_amount records the max that generated
  // it (for admin visibility); null on manual bids.
  isProxy: boolean("is_proxy").notNull().default(false),
  proxyAmount: numeric("proxy_amount", { precision: 18, scale: 2 }),
  ip: varchar("ip", { length: 64 }),
  // When the bidder committed to this amount — the priority key for every tie
  // ("earlier always wins"). Auto-bids carry their proxy's set time; null on
  // manual bids, which committed when written (read as
  // COALESCE(committed_at, created_at)).
  committedAt: timestamp("committed_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  // Hot path: per-lot bid_count / bidder_count (live snapshot + admin bids view)
  // filter by lot_id, and bidder_count is COUNT(DISTINCT bidder_id) per lot.
  // Without this, each count seq-scans the whole (large) table. The composite
  // covers COUNT(*) WHERE lot_id (prefix) and COUNT(DISTINCT bidder_id) WHERE
  // lot_id (index-only).
  index("auction_bids_lot_id_bidder_id_idx").on(table.lotId, table.bidderId),
]);

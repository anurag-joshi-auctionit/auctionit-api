import { integer, pgEnum, pgTable, timestamp } from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { auctionLots } from "./auction-lots.js";
import { bidders } from "./bidders.js";

// Why a lot's end time moved. Legacy kept these in two tables
// (tbl_Data_AuctionExtensionHistory for bids, tbl_Data_AuctionLotAutoIncrementHistory
// for no-bid extension); this table merges both, so the reason distinguishes them.
export const LOT_EXTENSION_REASONS = [
  "last_bid",
  "no_bid",
  "stagger",
] as const;
export type LotExtensionReason = (typeof LOT_EXTENSION_REASONS)[number];

export const lotExtensionReasonEnum = pgEnum(
  "lot_extension_reason",
  LOT_EXTENSION_REASONS,
);

// Audit of last-bid / no-bid / staggering extensions applied to a
// lot's end time.
export const auctionLotExtensions = pgTable("auction_lot_extensions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  auctionId: integer("auction_id")
    .notNull()
    .references(() => auctions.id),
  lotId: integer("lot_id")
    .notNull()
    .references(() => auctionLots.id),
  oldEndsAt: timestamp("old_ends_at", { withTimezone: true, mode: "string" }),
  newEndsAt: timestamp("new_ends_at", { withTimezone: true, mode: "string" }),
  extendedBySec: integer("extended_by_sec").notNull(),
  // The bid (bidder) that triggered the extension; null for no-bid and
  // staggered lots.
  triggeredByBidderId: integer("triggered_by_bidder_id").references(
    () => bidders.id,
  ),
  reason: lotExtensionReasonEnum("reason").notNull().default("last_bid"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

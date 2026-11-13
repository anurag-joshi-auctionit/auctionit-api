import {
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { auctionLots } from "./auction-lots.js";
import { bidders } from "./bidders.js";

// A bidder's watch list: the lots they've starred to follow. One row per
// (bidder, lot); the live room filters to these when "Watch List" is on.
// Rows are kept after lot/auction close so bidders can review tracked results.
// Port of the legacy IsAddedInWatchList / addWatchData flow.
export const auctionLotWatchlist = pgTable(
  "auction_lot_watchlist",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    lotId: integer("lot_id")
      .notNull()
      .references(() => auctionLots.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auction_lot_watchlist_bidder_lot_uidx").on(
      table.bidderId,
      table.lotId,
    ),
  ],
);

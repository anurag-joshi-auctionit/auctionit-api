import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

// A bidder's acceptance of an auction's Terms & Conditions (port of the legacy
// Proc_TnCAcceptanceUpdate / TnCAcceptance flag). One row per (auction, bidder)
// — acceptance is auction-wide, not per-lot. Presence of a row means accepted;
// there is no "un-accept". Gates whether the bidder can enter the auction in
// the old app's AuctionUnaccept flow.
//
// `ip` is the client IP at accept time (legacy
// tbl_Data_Auction_BidderCompUser_TnCAcceptance.IPAddress). When the auction
// has ip_address_restriction_enabled, an IP used here by one bidder cannot be
// used by any other bidder in the same auction (T&C or bidding).
export const auctionTncAcceptances = pgTable(
  "auction_tnc_acceptances",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    // The logged-in user who clicked accept (a bidder company can have multiple
    // users). Nullable for safety, but normally set.
    acceptedByUserId: integer("accepted_by_user_id").references(() => users.id),
    // Normalized client IP at T&C accept.
    ip: varchar("ip", { length: 64 }),
  },
  (t) => [
    uniqueIndex("auction_tnc_acceptances_auction_bidder_uidx").on(
      t.auctionId,
      t.bidderId,
    ),
    index("auction_tnc_acceptances_auction_ip_idx").on(t.auctionId, t.ip),
  ],
);

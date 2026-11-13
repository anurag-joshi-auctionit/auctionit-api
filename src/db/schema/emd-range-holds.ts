import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { auctionLotEmdRanges } from "./auction-lot-emd-ranges.js";
import { auctions } from "./auctions.js";
import { bidders } from "./bidders.js";

/**
 * The part of a bidder's Blocked EMD that stays blocked after the auction
 * closes: the EMD of the ranges whose lots the bidder won, one row per
 * (auction, bidder, EMD range). The money never leaves Blocked at close, so no
 * ledger entry moves it; this row records which range and lots it covers.
 *
 * It then ends in one of three ways: released (`amount_released`: lifting
 * release, lot rejection, or a reopened lot won by someone else), forfeited
 * (`amount_forfeited`, approved forfeiture) or still held. The amount still
 * held is `amount_held - amount_released - amount_forfeited`. `emd_range_id`
 * is NULL when the auction has no ranges or a won lot is outside every range.
 */
export const emdRangeHolds = pgTable(
  "emd_range_holds",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    emdRangeId: integer("emd_range_id").references(() => auctionLotEmdRanges.id),
    amountHeld: numeric("amount_held", { precision: 18, scale: 2 }).notNull(),
    amountReleased: numeric("amount_released", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    amountForfeited: numeric("amount_forfeited", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    /** Won lots the hold covers. */
    lotIds: integer("lot_ids")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "emd_range_holds_amounts_valid",
      sql`${t.amountHeld} >= 0 AND ${t.amountReleased} >= 0 AND ${t.amountForfeited} >= 0`,
    ),
    uniqueIndex("emd_range_holds_target_unique").on(
      t.auctionId,
      t.bidderId,
      sql`coalesce(${t.emdRangeId}, 0)`,
    ),
    index("emd_range_holds_bidder_id_idx").on(t.bidderId),
  ],
);
export type EmdRangeHold = typeof emdRangeHolds.$inferSelect;

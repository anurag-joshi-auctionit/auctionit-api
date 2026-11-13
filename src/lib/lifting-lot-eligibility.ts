import { and, eq, isNotNull, type SQL } from "drizzle-orm";
import { auctionLots } from "../db/schema/index.js";

/**
 * Lots eligible for lifting lists/detail: approved and with Winning price + Winning bidder.
 * Matches settlement approval gate (`assertLotsHaveWinningForApproval`).
 */
export const liftingEligibleLotCondition: SQL = and(
  eq(auctionLots.isApproved, true),
  isNotNull(auctionLots.winningAmount),
  isNotNull(auctionLots.winnerBidderId),
)!;

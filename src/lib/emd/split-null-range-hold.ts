import {
  planCloseSettlement,
  type HoldTarget,
  type SettlementRange,
  type SettlementWonLot,
} from "./close-settlement.js";
import { round2 } from "./constants.js";

/**
 * Splits a hold recorded with no EMD range (legacy closes) into one hold per
 * won range, the way a close would allocate it today. Returns null when the
 * split is not safe: the hold already has releases or forfeitures, a lot falls
 * outside every range, or the ranges do not add up to the held amount.
 */
export function splitNullRangeHold(input: {
  amountHeld: number;
  amountReleased: number;
  amountForfeited: number;
  ranges: SettlementRange[];
  wonLots: SettlementWonLot[];
}): HoldTarget[] | null {
  if (input.amountReleased > 0 || input.amountForfeited > 0) return null;
  if (input.ranges.length === 0 || input.wonLots.length === 0) return null;

  const plan = planCloseSettlement({
    blockedBalance: input.amountHeld,
    ranges: input.ranges,
    wonLots: input.wonLots,
  });
  if (plan.holds.length === 0 || plan.holds.some((h) => h.emdRangeId == null)) return null;
  if (round2(plan.holds.reduce((s, h) => s + h.amount, 0)) !== round2(input.amountHeld)) return null;
  return plan.holds;
}

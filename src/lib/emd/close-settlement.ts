import { isLotDisplayOrderCoveredByRange } from "./emd-required.js";
import { round2 } from "./constants.js";

export type SettlementRange = {
  id: number;
  displayOrder: number | null;
  emdAmount: number;
  lotDisplayOrderFrom: number;
  lotDisplayOrderTo: number;
};

export type SettlementWonLot = {
  lotId: number;
  displayOrder: number | null;
};

/** What a bidder keeps blocked on one EMD range after the close. */
export type HoldTarget = {
  /** NULL when the auction has no ranges or a won lot is outside every range. */
  emdRangeId: number | null;
  amount: number;
  lotIds: number[];
};

export type CloseSettlementPlan = {
  /** Ranges the bidder keeps blocked; every other range holds nothing. */
  holds: HoldTarget[];
  /** Blocked amount going back to Available: the block minus what stays held. */
  releaseAmount: number;
};

/**
 * Close-time settlement for one bidder on one auction. The EMD of every won
 * range stays blocked (capped by the block, allocated in EMD display order);
 * the rest of the block goes back to Available. It is computed from the whole
 * already-blocked amount and the lots the bidder wins now, so running it again after a
 * reopen needs no special case: a range whose lots were lost, or that the
 * block no longer covers, drops out of `holds` and its money is released.
 *
 * `consumedRangeIds` are ranges already released or forfeited; they are left
 * alone and not held again.
 */
export function planCloseSettlement(input: {
  blockedBalance: number;
  ranges: SettlementRange[];
  wonLots: SettlementWonLot[];
  consumedRangeIds?: ReadonlySet<number | null>;
}): CloseSettlementPlan {
  const blocked = round2(input.blockedBalance);
  if (blocked <= 0) return { holds: [], releaseAmount: 0 };
  const consumed = input.consumedRangeIds ?? new Set<number | null>();
  const result = (holds: HoldTarget[]): CloseSettlementPlan => ({
    holds,
    releaseAmount: round2(blocked - holds.reduce((s, h) => s + h.amount, 0)),
  });

  const wonLots = input.wonLots;
  if (wonLots.length === 0) return result([]);

  const holdEverything = (): CloseSettlementPlan =>
    consumed.has(null)
      ? result([])
      : result([
          {
            emdRangeId: null,
            amount: blocked,
            lotIds: wonLots.map((l) => l.lotId),
          },
        ]);

  if (input.ranges.length === 0) return holdEverything();

  const lotsByRange = new Map<number, number[]>();
  for (const lot of wonLots) {
    const range =
      lot.displayOrder == null
        ? undefined
        : input.ranges.find((r) =>
            isLotDisplayOrderCoveredByRange(lot.displayOrder!, r),
          );
    if (!range) return holdEverything();
    const list = lotsByRange.get(range.id) ?? [];
    list.push(lot.lotId);
    lotsByRange.set(range.id, list);
  }

  const wonRanges = input.ranges
    .filter((r) => lotsByRange.has(r.id) && !consumed.has(r.id))
    .sort(
      (a, b) =>
        (a.displayOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.displayOrder ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
    );

  let remaining = blocked;
  const holds: HoldTarget[] = [];
  for (const range of wonRanges) {
    if (remaining <= 0) break;
    const amount = round2(Math.min(remaining, range.emdAmount));
    if (amount <= 0) continue;
    holds.push({
      emdRangeId: range.id,
      amount,
      lotIds: lotsByRange.get(range.id)!,
    });
    remaining = round2(remaining - amount);
  }
  return result(holds);
}

/** A stored hold row, as far as reconciling it needs. */
export type ExistingHold = {
  emdRangeId: number | null;
  amountReleased: number;
  amountForfeited: number;
};

export type HoldWrite = {
  emdRangeId: number | null;
  /** New `amount_held`: what was already released or forfeited plus the target. */
  amountHeld: number;
  lotIds: number[];
  isNew: boolean;
};

/**
 * Row writes that make every range hold exactly its target: a target with no
 * row gets one, a target with a row is moved to the new amount and lots, and a
 * row whose range is no longer a target drops to zero held. A row that was
 * partly released or forfeited keeps those amounts, so only the held part moves.
 */
export function holdWrites(input: {
  targets: HoldTarget[];
  existing: ExistingHold[];
}): HoldWrite[] {
  const targetByRange = new Map(input.targets.map((t) => [t.emdRangeId, t]));
  const existingByRange = new Map(input.existing.map((e) => [e.emdRangeId, e]));
  const writes: HoldWrite[] = [];
  for (const target of input.targets) {
    const row = existingByRange.get(target.emdRangeId);
    writes.push({
      emdRangeId: target.emdRangeId,
      amountHeld: round2(
        (row?.amountReleased ?? 0) +
          (row?.amountForfeited ?? 0) +
          target.amount,
      ),
      lotIds: target.lotIds,
      isNew: row == null,
    });
  }
  for (const row of input.existing) {
    if (targetByRange.has(row.emdRangeId)) continue;
    writes.push({
      emdRangeId: row.emdRangeId,
      amountHeld: round2(row.amountReleased + row.amountForfeited),
      lotIds: [],
      isNew: false,
    });
  }
  return writes;
}

/**
 * Lots to list on a close release: lots with a wallet block that were not won
 * and do not sit in a range that stays blocked. A hold with no range keeps the
 * whole block, so nothing is listed.
 */
export function releasedLotIds(
  walletLots: { lotId: number; displayOrder: number | null }[],
  wonLots: SettlementWonLot[],
  holds: { emdRangeId: number | null }[],
  ranges: SettlementRange[],
): number[] {
  if (holds.some((h) => h.emdRangeId == null)) return [];
  const won = new Set(wonLots.map((l) => l.lotId));
  const heldRanges = ranges.filter((r) =>
    holds.some((h) => h.emdRangeId === r.id),
  );
  return walletLots
    .filter(
      (l) =>
        !won.has(l.lotId) &&
        !(
          l.displayOrder != null &&
          heldRanges.some((r) =>
            isLotDisplayOrderCoveredByRange(l.displayOrder!, r),
          )
        ),
    )
    .map((l) => l.lotId);
}

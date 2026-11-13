import { EmdValidationMessages } from "@auctionit/messages/emd";
import type { EmdRangeBounds } from "../auctions/emd-range-validation.js";

export type EmdRangeWithAmount = EmdRangeBounds & {
  emdAmount: number;
};

export type EmdCoverageLot = {
  lotId: number;
  displayOrder: number | null;
};

export function isLotDisplayOrderCoveredByRange(
  displayOrder: number,
  range: EmdRangeBounds,
): boolean {
  return (
    displayOrder >= range.lotDisplayOrderFrom &&
    displayOrder <= range.lotDisplayOrderTo
  );
}

function isCovered(displayOrder: number, range: EmdRangeBounds): boolean {
  return isLotDisplayOrderCoveredByRange(displayOrder, range);
}

/** EMD range row keyed by its auction `display_order` (EMD display order). */
export type EmdRangeWithDisplayOrder = EmdRangeWithAmount & {
  displayOrder: number | null;
};

export type BidderEmdRequiredInput = {
  /** Lots the bidder is being mapped to. */
  selectedLots: EmdCoverageLot[];
  /**
   * Display-order EMD ranges configured for the auction.
   * Each range must have `displayOrder` (emd_display_order) set.
   */
  ranges: EmdRangeWithDisplayOrder[];
  /** Per-auction consolidated EMD ceiling (null when not configured). */
  consolidatedEmd: number | null;
};

/** Cap a required-EMD sum at the auction's consolidated ceiling, when set. */
export function capByConsolidatedEmd(
  consolidatedEmd: number | null,
  sum: number,
): number {
  return consolidatedEmd != null ? Math.min(consolidatedEmd, sum) : sum;
}

export type BidderEmdRequiredResult = {
  /** Amount to block: min(consolidated ceiling, sum of unique emd_display_order amounts). */
  emdRequired: number;
  /** Sum of EMD for the unique emd_display_orders resolved from selected lots. */
  rangeEmdSum: number;
  /** Selected lots that fall outside every configured range (or whose range lacks displayOrder). */
  uncoveredLotIds: number[];
};

/**
 * Compute the EMD a bidder must block for the given lots.
 *
 * For each selected lot, resolve the covering EMD range and collect its
 * `displayOrder` (emd_display_order) into a set. Sum the full `emdAmount` for
 * every unique order in that set, then cap with the auction consolidated EMD
 * when set: `min(consolidatedEmd, sum)`.
 */
export function computeBidderEmdRequired(
  input: BidderEmdRequiredInput,
): BidderEmdRequiredResult {
  const { selectedLots, ranges, consolidatedEmd } = input;

  const selectedWithOrder = selectedLots.filter(
    (l): l is EmdCoverageLot & { displayOrder: number } =>
      l.displayOrder != null,
  );

  // No ranges configured: fall back to the consolidated EMD as the requirement.
  if (ranges.length === 0) {
    return {
      emdRequired: consolidatedEmd ?? 0,
      rangeEmdSum: consolidatedEmd ?? 0,
      uncoveredLotIds: [],
    };
  }

  const emdDisplayOrders = new Set<number>();
  const uncoveredLotIds: number[] = [];

  for (const lot of selectedWithOrder) {
    const range = ranges.find((r) => isCovered(lot.displayOrder, r));
    if (!range || range.displayOrder == null) {
      uncoveredLotIds.push(lot.lotId);
      continue;
    }
    emdDisplayOrders.add(range.displayOrder);
  }

  let rangeEmdSum = 0;
  for (const order of emdDisplayOrders) {
    const range = ranges.find((r) => r.displayOrder === order);
    if (range) rangeEmdSum += range.emdAmount;
  }

  const emdRequired = capByConsolidatedEmd(consolidatedEmd, rangeEmdSum);

  return {
    emdRequired: round2(emdRequired),
    rangeEmdSum: round2(rangeEmdSum),
    uncoveredLotIds,
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export type ResolveEmdRangesResult = {
  ranges: Array<EmdRangeWithAmount & { displayOrder: number }>;
  missingOrders: number[];
};

/** Resolve listed EMD display orders to configured range rows. */
export function resolveEmdRangesByDisplayOrders(
  orders: number[],
  ranges: EmdRangeWithDisplayOrder[],
): ResolveEmdRangesResult {
  const byOrder = new Map(
    ranges
      .filter(
        (r): r is EmdRangeWithAmount & { displayOrder: number } =>
          r.displayOrder != null,
      )
      .map((r) => [r.displayOrder, r] as const),
  );
  const resolved: Array<EmdRangeWithAmount & { displayOrder: number }> = [];
  const missingOrders: number[] = [];
  const seen = new Set<number>();

  for (const order of orders) {
    if (seen.has(order)) continue;
    seen.add(order);
    const range = byOrder.get(order);
    if (range) resolved.push(range);
    else missingOrders.push(order);
  }

  return { ranges: resolved, missingOrders };
}

export type LotEmdSyncResult = {
  ok: boolean;
  errors: string[];
};

/**
 * Bidirectional sync: every lot order must fall in a listed EMD range, and
 * every listed EMD range must cover at least one listed lot order.
 */
export function assertLotEmdDisplayOrdersInSync(input: {
  lotOrders: number[];
  emdRanges: Array<EmdRangeWithAmount & { displayOrder: number }>;
}): LotEmdSyncResult {
  const { lotOrders, emdRanges } = input;
  const errors: string[] = [];

  const emdOrdersLabel = emdRanges.map((r) => r.displayOrder).join(", ");

  for (const lotOrder of lotOrders) {
    const covered = emdRanges.some((r) =>
      isLotDisplayOrderCoveredByRange(lotOrder, r),
    );
    if (!covered) {
      errors.push(
        `Lot display order ${lotOrder} is not covered by emdDisplayOrders ${emdOrdersLabel}`,
      );
    }
  }

  for (const range of emdRanges) {
    const used = lotOrders.some((lotOrder) =>
      isLotDisplayOrderCoveredByRange(lotOrder, range),
    );
    if (!used) {
      errors.push(
        `emdDisplayOrder ${range.displayOrder} covers none of the listed lotDisplayOrders`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/** All auction lots whose display order falls in any of the given EMD ranges. */
export function expandLotsFromEmdRanges(input: {
  allLots: EmdCoverageLot[];
  emdRanges: Array<EmdRangeBounds>;
}): number[] {
  const { allLots, emdRanges } = input;
  const lotIds: number[] = [];
  for (const lot of allLots) {
    if (lot.displayOrder == null) continue;
    if (
      emdRanges.some((r) =>
        isLotDisplayOrderCoveredByRange(lot.displayOrder!, r),
      )
    ) {
      lotIds.push(lot.lotId);
    }
  }
  return lotIds;
}

/**
 * Sum full EMD amounts for the listed EMD display-order ranges (no lot
 * proration), then apply the consolidated ceiling when set.
 */
export function computeBidderEmdRequiredFromEmdDisplayOrders(input: {
  ranges: EmdRangeWithAmount[];
  consolidatedEmd: number | null;
}): { emdRequired: number; rangeEmdSum: number } {
  const rangeEmdSum = input.ranges.reduce((sum, r) => sum + r.emdAmount, 0);
  const emdRequired = capByConsolidatedEmd(input.consolidatedEmd, rangeEmdSum);
  return {
    emdRequired: round2(emdRequired),
    rangeEmdSum: round2(rangeEmdSum),
  };
}

export type BlockValidationInput = {
  isEmdWithClient: boolean;
  /** EMD to block: the requirement of the bidder's non-client lots. */
  emdRequired: number;
  /** Bidder wallet balance available to block, including any block being replaced. */
  emdAvailable: number;
};

/**
 * Validate a single bidder EMD-block row. The block is always Full, so the only
 * rule is that the wallet can cover it.
 *
 * Returns a human-readable error message, or `null` when the row is valid.
 * When `isEmdWithClient` is true nothing is blocked from the wallet.
 */
export function validateBlockRow(input: BlockValidationInput): string | null {
  const { isEmdWithClient, emdRequired, emdAvailable } = input;

  if (isEmdWithClient) return null;

  if (round2(emdRequired) > round2(emdAvailable)) {
    return EmdValidationMessages.BLOCK_INSUFFICIENT(emdAvailable, emdRequired);
  }

  return null;
}

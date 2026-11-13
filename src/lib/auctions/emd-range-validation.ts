import { AuctionsValidationMessages } from "@auctionit/messages/auctions";

export type EmdRangeBounds = {
  lotDisplayOrderFrom: number;
  lotDisplayOrderTo: number;
};

export type EmdCoverageLot = {
  lotId: number;
  lotNumber: string | null;
  displayOrder: number | null;
};

export type UnmappedLot = EmdCoverageLot & {
  reason: "missing_display_order" | "uncovered" | "overlapping_ranges";
};

/** Inclusive interval overlap on display-order numbers. */
export function rangesOverlap(a: EmdRangeBounds, b: EmdRangeBounds): boolean {
  return (
    a.lotDisplayOrderFrom <= b.lotDisplayOrderTo &&
    b.lotDisplayOrderFrom <= a.lotDisplayOrderTo
  );
}

export function findOverlappingPairIndices(
  ranges: EmdRangeBounds[],
): [number, number] | null {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (rangesOverlap(ranges[i]!, ranges[j]!)) {
        return [i, j];
      }
    }
  }
  return null;
}

export function hasOverlappingRanges(ranges: EmdRangeBounds[]): boolean {
  return findOverlappingPairIndices(ranges) != null;
}

export function coveringRangeCount(
  displayOrder: number,
  ranges: EmdRangeBounds[],
): number {
  let hits = 0;
  for (const r of ranges) {
    if (
      displayOrder >= r.lotDisplayOrderFrom &&
      displayOrder <= r.lotDisplayOrderTo
    ) {
      hits++;
    }
  }
  return hits;
}

export function unmappedLots(
  lots: EmdCoverageLot[],
  ranges: EmdRangeBounds[],
): UnmappedLot[] {
  const result: UnmappedLot[] = [];
  for (const lot of lots) {
    if (lot.displayOrder == null) {
      result.push({ ...lot, reason: "missing_display_order" });
      continue;
    }
    const hits = coveringRangeCount(lot.displayOrder, ranges);
    if (hits === 0) {
      result.push({ ...lot, reason: "uncovered" });
    } else if (hits > 1) {
      result.push({ ...lot, reason: "overlapping_ranges" });
    }
  }
  return result;
}

export function isFullyMapped(
  lots: EmdCoverageLot[],
  ranges: EmdRangeBounds[],
): boolean {
  return unmappedLots(lots, ranges).length === 0;
}

/**
 * Among `selectedLotIds`, return those that are unmapped for the given lots/ranges.
 * Used to block bidder attach / import when some selected lots fall outside EMD coverage,
 * even if other lots on the auction are already mapped.
 */
export function unmappedSelectedLotIds(
  lots: EmdCoverageLot[],
  ranges: EmdRangeBounds[],
  selectedLotIds: number[],
): number[] {
  if (selectedLotIds.length === 0) return [];
  const unmappedIds = new Set(unmappedLots(lots, ranges).map((l) => l.lotId));
  return selectedLotIds.filter((id) => unmappedIds.has(id));
}

export type SaveableCheck = {
  ok: boolean;
  hasOverlap: boolean;
  unmapped: UnmappedLot[];
  message: string | null;
};

export function assertSaveable(
  lots: EmdCoverageLot[],
  ranges: EmdRangeBounds[],
): SaveableCheck {
  const hasOverlap = hasOverlappingRanges(ranges);
  if (hasOverlap) {
    return {
      ok: false,
      hasOverlap: true,
      unmapped: unmappedLots(lots, ranges),
      message: AuctionsValidationMessages.EMD_RANGE_OVERLAP,
    };
  }
  const unmapped = unmappedLots(lots, ranges);
  if (unmapped.length > 0) {
    return {
      ok: false,
      hasOverlap: false,
      unmapped,
      message: AuctionsValidationMessages.EMD_MAP_ALL_LOTS,
    };
  }
  return { ok: true, hasOverlap: false, unmapped: [], message: null };
}

/** Tolerance for comparing 2-decimal money totals (avoids float drift). */
const EMD_TOTAL_EPS = 0.005;

/** Sum EMD amounts, rounded to 2 decimals. */
export function sumRangeEmd(amounts: number[]): number {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

export type EmdTotalsCheck = { ok: boolean; message: string | null };

/**
 * Enforce that lot-wise EMD covers the consolidated EMD:
 * - at least one lot-wise range must exist, and
 * - the sum of range EMD amounts must be >= the consolidated EMD.
 *
 * This guarantees a bidder mapped to every lot blocks at least the consolidated
 * amount, since bid-time EMD is `min(consolidated, sum(range EMD))`.
 */
export function checkEmdTotals(input: {
  rangeCount: number;
  rangeEmdSum: number;
  consolidatedEmd: number;
}): EmdTotalsCheck {
  if (input.rangeCount < 1) {
    return {
      ok: false,
      message: AuctionsValidationMessages.EMD_AT_LEAST_ONE_RANGE,
    };
  }
  if (input.rangeEmdSum + EMD_TOTAL_EPS < input.consolidatedEmd) {
    return {
      ok: false,
      message: AuctionsValidationMessages.EMD_TOTAL_BELOW_CONSOLIDATED,
    };
  }
  return { ok: true, message: null };
}

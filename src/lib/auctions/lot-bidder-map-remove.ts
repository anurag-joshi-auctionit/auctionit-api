/**
 * Normalize and validate lot–bidder remove selection (dedupe IDs, compute
 * cartesian pair count for response/UI messaging).
 */
export function normalizeLotBidderRemoveSelection(
  bidderIds: number[],
  lotIds: number[],
): {
  bidderIds: number[];
  lotIds: number[];
  requestedPairs: number;
} | null {
  const uniqueBidders = [...new Set(bidderIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  const uniqueLots = [...new Set(lotIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (uniqueBidders.length === 0 || uniqueLots.length === 0) {
    return null;
  }
  return {
    bidderIds: uniqueBidders,
    lotIds: uniqueLots,
    requestedPairs: uniqueBidders.length * uniqueLots.length,
  };
}

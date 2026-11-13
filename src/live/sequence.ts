/** Monotonic per-auction sequence for live events — clients drop out-of-order deltas. */

const sequences = new Map<number, number>();

export function nextAuctionSeq(auctionId: number): number {
  const next = (sequences.get(auctionId) ?? 0) + 1;
  sequences.set(auctionId, next);
  return next;
}

export function currentAuctionSeq(auctionId: number): number {
  return sequences.get(auctionId) ?? 0;
}

/**
 * Release a blocked EMD reservation only when the bidder can no longer
 * participate and has no bids or active proxy on that auction.
 */
export function shouldReleaseAuctionEmd(counts: {
  remainingActiveMaps: number;
  bidCount: number;
  activeProxyCount: number;
}): boolean {
  return (
    counts.remainingActiveMaps === 0 &&
    counts.bidCount === 0 &&
    counts.activeProxyCount === 0
  );
}

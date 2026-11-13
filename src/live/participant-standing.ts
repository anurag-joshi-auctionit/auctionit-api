/** Relative standing for a bidder on a lot (join snap + private live:standing). */
export function participantStanding(opts: {
  winnerBidderId: number | null;
  bidderId: number;
  hasLiveBid: boolean;
}): "winning" | "outbid" | "none" {
  if (opts.winnerBidderId == null) return "none";
  if (opts.bidderId === opts.winnerBidderId) return "winning";
  // Removed-only winning bid (no ledger row left) must not show Outbid.
  if (!opts.hasLiveBid) return "none";
  return "outbid";
}

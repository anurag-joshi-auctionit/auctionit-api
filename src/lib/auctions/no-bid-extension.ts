/**
 * No-bid lot extension rules — the port of legacy `usp_PushUpdate`.
 *
 * A live lot that has attracted no bid by the time it is about to close gets
 * its end time pushed out by the auction's `no_bid_extension_interval` seconds,
 * up to `no_bid_extension_count_max` times. Note this is a different mechanism
 * from the bid-triggered anti-sniping extension in live-bid.service.ts: that
 * one is gated by the client's `is_last_bid_extension` / `last_bid_extension_*`
 * settings, this one is gated purely by the auction-level no-bid extension
 * settings (legacy checks no client flag here either).
 *
 * The engine applies these rules in SQL so a whole tick is one statement; this
 * module keeps them readable and unit-testable in one place.
 */

/**
 * Clock-skew epsilon around a lot's effective end: the engine evaluates a
 * lot once it has reached (not before) its end, within this many seconds
 * either side, to absorb DB/event-loop jitter between a tick starting and
 * its query running. This is deliberately NOT a pre-emptive lookahead
 * window — a lot is only a candidate once its end is actually at/near now.
 */
export const NO_BID_EXTENSION_LEAD_SEC = 1;

/**
 * How far past its end a lot may still be picked up (guards against a
 * missed tick, e.g. after a restart) without reopening a pre-emptive window.
 */
export const NO_BID_EXTENSION_STALENESS_GUARD_SEC = 60;

/** Poll interval for the no-bid engine (ms). */
export const NO_BID_EXTENSION_TICK_MS = 2_000;

/** @deprecated Use NO_BID_EXTENSION_LEAD_SEC */
export const DEFAULT_NO_BID_EXTENSION_LEAD_SEC = NO_BID_EXTENSION_LEAD_SEC;

export type NoBidExtensionInput = {
  /** auction_lots.is_active */
  lotIsActive: boolean;
  /** auction_lots.is_no_bid_extension — false once an admin stops the lot. */
  lotNoBidExtensionEnabled: boolean;
  /** auctions.is_no_bid_extension — null is treated as on, per legacy. */
  auctionNoBidExtensionEnabled: boolean | null;
  /** auctions.no_bid_extension_interval, in seconds. */
  intervalSeconds: number | null;
  /** auctions.no_bid_extension_count_max. */
  maxCount: number | null;
  /** auction_lots.no_bid_extension_count — times this lot already extended. */
  currentCount: number;
  /** True once any bid has landed on the lot (winner set or bid_count > 0). */
  hasBid: boolean;
  /** Seconds until the lot's effective end. Negative once the lot has closed. */
  secondsToEnd: number;
  /** Seconds until the lot opens. Positive while it has not started. */
  secondsToStart: number;
  /** Clock-skew epsilon; defaults to NO_BID_EXTENSION_LEAD_SEC. */
  leadSec?: number;
};

/**
 * Whether a lot should no-bid-extend right now. Mirrors the WHERE clause of
 * legacy `usp_PushUpdate` one-for-one.
 */
export function shouldNoBidExtension(input: NoBidExtensionInput): boolean {
  const leadSec = input.leadSec ?? NO_BID_EXTENSION_LEAD_SEC;
  const interval = input.intervalSeconds ?? 0;
  const maxCount = input.maxCount ?? 0;

  if (!input.lotIsActive) return false;
  // Admin stopped no-bid extension for this lot (legacy: row present in
  // tbl_Data_AuctionLotForCloseAutoTimeIncrement).
  if (!input.lotNoBidExtensionEnabled) return false;
  // Legacy `isnull(ac.IsAuctionAutoIncrement, 1) = 1` — null means on.
  if (input.auctionNoBidExtensionEnabled === false) return false;
  if (interval <= 0) return false;
  if (input.currentCount >= maxCount) return false;
  // Only lots nobody has bid on.
  if (input.hasBid) return false;
  // Lot must be open: started, and not yet past its end.
  if (input.secondsToStart > 0) return false;
  // Past the staleness guard means a tick was missed long enough ago that
  // this is no longer "right at T-0" — don't resurrect it pre-emptively.
  if (input.secondsToEnd < -NO_BID_EXTENSION_STALENESS_GUARD_SEC) return false;
  // Evaluate at/just past the effective end, within the clock-skew epsilon —
  // never before it.
  return input.secondsToEnd <= leadSec;
}

export type NoBidCandidateRankInput = {
  lotId: number;
  /** Effective end as epoch milliseconds. */
  effectiveEndMs: number;
  displayOrder: number | null;
};

/**
 * Rank no-bid candidates for the stagger gate: earliest effective end first,
 * then display_order, then lot id. Matches bumpNoBidLots ROW_NUMBER ordering.
 */
export function compareNoBidCandidateRank(
  a: NoBidCandidateRankInput,
  b: NoBidCandidateRankInput,
): number {
  if (a.effectiveEndMs !== b.effectiveEndMs) {
    return a.effectiveEndMs - b.effectiveEndMs;
  }
  const ao = a.displayOrder;
  const bo = b.displayOrder;
  if (ao != null && bo != null && ao !== bo) return ao - bo;
  if (ao != null && bo == null) return -1;
  if (ao == null && bo != null) return 1;
  return a.lotId - b.lotId;
}

/** 1-based rank among lead-window candidates; -1 when the lot is not listed. */
export function rankAmongNoBidCandidates(
  lotId: number,
  candidates: NoBidCandidateRankInput[],
): number {
  const sorted = [...candidates].sort(compareNoBidCandidateRank);
  const idx = sorted.findIndex((c) => c.lotId === lotId);
  return idx < 0 ? -1 : idx + 1;
}

/**
 * When lot-staggering is on, only the chronologically earliest candidate in an
 * auction (rank 1) should consume a no-bid bump; later lots are moved by
 * stagger alone. Rank is 1-based among lead-window no-bid candidates ordered
 * by effective end, then display_order.
 */
export function shouldNoBidBumpWithStagger(input: {
  enabled: boolean | null;
  intervalSec: number | null;
  /** 1 = earliest-closing lot among no-bid candidates in the lead window. */
  rankAmongCandidates: number;
}): boolean {
  if (!input.enabled || (input.intervalSec ?? 0) <= 0) return true;
  return input.rankAmongCandidates === 1;
}

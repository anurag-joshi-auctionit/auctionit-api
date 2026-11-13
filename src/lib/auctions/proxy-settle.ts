/**
 * Proxy (auto-bid) settlement — the pure core of the auto-bid engine.
 *
 * One rule governs every tie: **earlier always wins**. At any amount, the
 * bidder who committed to it first holds it — a proxy commits to every amount
 * up to its limit when it is set, a manual bid when it is placed.
 *
 * Given the field of standing limits on a lot, this decides who is winning and
 * at what price. Direction-aware:
 *
 * Forward (ascending):
 *   - The highest limit wins; equal limits go to the earliest committed.
 *   - Winner committed before the runner-up: it matches the runner-up's limit
 *     and wins that amount on time.
 *   - Winner committed after the runner-up: it must beat the runner-up, so it
 *     sits one increment above the runner-up's limit, capped at its own max.
 *
 * Reverse (descending): mirrored — lowest limit wins, one increment below.
 *
 * Example (SBP 4000, inc 200): b1 proxies 5000, then b2 proxies 5000 → b1 at
 * 5000. b1 proxies 5000, then b2 bids 4600 → b1 at 4600.
 *
 * Money is handled in integer paise by the caller; here amounts are plain
 * numbers and comparisons are exact because every limit is validated to be a
 * whole multiple of the increment before it reaches this function.
 */

import type { BidDirection } from "@auctionit/lib/bid-direction";

export type Contender = {
  /** bidders.id */
  bidderId: number;
  /**
   * The bidder's ceiling (forward) or floor/minimum (reverse). For a manual
   * leader with no proxy, their standing bid amount.
   */
  max: number;
  /**
   * When the bidder committed to `max` (lower = earlier), e.g. epoch
   * microseconds: a proxy's set time, or a manual leader's bid time at the
   * winning amount. Ties on `max` go to the lower value.
   */
  order: number;
  /** False for the synthetic "manual leader" contender (already holds the lot). */
  isProxy: boolean;
};

export type Settlement = {
  /** The bidder who should hold the lot after settling. */
  winnerBidderId: number;
  /** The price the winner should be sitting at. */
  amount: number;
  /** True when the winner is a proxy and needs an auto-bid written. */
  winnerIsProxy: boolean;
};

/**
 * Settle a lot given all contenders (active proxies plus, optionally, a manual
 * leader), the lot's start price, and the increment. Returns null when nothing
 * needs to change — no proxies.
 *
 * Every contender other than the winner ends at or below the settled amount,
 * so each losing proxy is exhausted at its limit (the caller records it).
 *
 * @param direction +1 forward (highest wins), −1 reverse (lowest wins).
 */
export function settleProxies(
  contenders: Contender[],
  startPrice: number,
  increment: number,
  // When the auction forces the opening bid above/below the start price
  // ("First Bid = Start Bid Price ± Increment").
  sbpPlusIncrement = false,
  direction: BidDirection = 1,
): Settlement | null {
  const proxies = contenders.filter((c) => c.isProxy);
  if (proxies.length === 0) return null;

  // Best limit first; ties broken by earliest commitment (lower order).
  const field = [...contenders].sort((a, b) =>
    a.max !== b.max
      ? direction === 1
        ? b.max - a.max
        : a.max - b.max
      : a.order - b.order,
  );

  const top1 = field[0]!;
  const top2 = field[1];

  // A lone contender (necessarily a single proxy, no manual leader) opens at the
  // first-bid floor/ceiling: the start price, or start ± one increment when the
  // auction forces the opening bid off the start price.
  if (!top2) {
    return {
      winnerBidderId: top1.bidderId,
      amount: sbpPlusIncrement
        ? startPrice + direction * increment
        : startPrice,
      winnerIsProxy: top1.isProxy,
    };
  }

  // Earlier winner: holds the runner-up's limit on time. Later winner: one
  // increment past it, never beyond its own limit.
  const amount =
    top1.order < top2.order
      ? top2.max
      : direction === 1
        ? Math.min(top1.max, top2.max + increment)
        : Math.max(top1.max, top2.max - increment);

  return {
    winnerBidderId: top1.bidderId,
    amount,
    winnerIsProxy: top1.isProxy,
  };
}

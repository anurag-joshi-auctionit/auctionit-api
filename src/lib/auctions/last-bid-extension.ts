/**
 * Last-bid (anti-snipe) extension gate — the bid-path counterpart to
 * `shouldNoBidExtension`. Used by `LiveBidService.maybeExtend` after an
 * accepted bid/proxy.
 */

export type LastBidExtensionInput = {
  /** clients.is_last_bid_extension */
  isLastBidExtension: boolean | null;
  /** clients.last_bid_extension_window — seconds remaining that count as "last bid". */
  lastBidExtensionWindow: number | null;
  /** clients.last_bid_extension_interval — seconds to add to the lot end. */
  lastBidExtensionInterval: number | null;
  /** clients.last_bid_extension_count_max — max last-bid extensions per lot. */
  lastBidExtensionCountMax: number | null;
  /** auction_lots.last_bid_extension_count — times this lot already extended. */
  lastBidExtensionCount: number;
  /** Seconds until the lot's effective end. Must be > 0 (still open). */
  timeLeftSec: number;
  /** Whether the lot has an effective end timestamp to extend. */
  hasEffectiveEnd: boolean;
  /** auction_lots.is_reopened — reopened lots close at their set end, never extended. */
  isReopened?: boolean;
};

/**
 * Whether a bid/proxy event should last-bid-extend the lot right now.
 */
export function shouldLastBidExtension(input: LastBidExtensionInput): boolean {
  const window = input.lastBidExtensionWindow;
  const extendBy = input.lastBidExtensionInterval;
  return (
    input.isReopened !== true &&
    input.isLastBidExtension === true &&
    window != null &&
    window > 0 &&
    extendBy != null &&
    extendBy > 0 &&
    input.hasEffectiveEnd &&
    input.timeLeftSec > 0 &&
    input.timeLeftSec <= window &&
    // Legacy: null / non-positive max ⇒ no extensions (not unlimited).
    input.lastBidExtensionCountMax != null &&
    input.lastBidExtensionCountMax > 0 &&
    input.lastBidExtensionCount < input.lastBidExtensionCountMax
  );
}

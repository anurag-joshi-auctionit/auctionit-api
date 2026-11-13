import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { shouldLastBidExtension } from "./last-bid-extension.js";

export type UpdateLotCorrectionCase =
  | "qty_only"
  | "same_price_new_bidder"
  | "new_price"
  | "noop";

export function amountsEqual(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.round(a * 100) === Math.round(b * 100);
}

/** Lot quantity uses scale 3. */
export function quantitiesEqual(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.round(a * 1000) === Math.round(b * 1000);
}

export function classifyUpdateLotCase(input: {
  currentWinnerBidderId: number | null;
  currentWinningAmount: number | null;
  currentQuantity: number | null;
  nextWinnerBidderId: number | null | undefined;
  nextWinningAmount: number | null | undefined;
  nextQuantity: number | null | undefined;
}): UpdateLotCorrectionCase {
  const nextWinner =
    input.nextWinnerBidderId !== undefined
      ? input.nextWinnerBidderId
      : input.currentWinnerBidderId;
  const nextAmount =
    input.nextWinningAmount !== undefined
      ? input.nextWinningAmount
      : input.currentWinningAmount;
  const nextQty =
    input.nextQuantity !== undefined
      ? input.nextQuantity
      : input.currentQuantity;

  const winnerChanged = nextWinner !== input.currentWinnerBidderId;
  const amountChanged = !amountsEqual(nextAmount, input.currentWinningAmount);
  const qtyChanged = !quantitiesEqual(nextQty, input.currentQuantity);

  if (amountChanged) return "new_price";
  if (winnerChanged) return "same_price_new_bidder";
  if (qtyChanged) return "qty_only";
  return "noop";
}

export type CorrectionBidTimestampInput = {
  lastBidCreatedAt: Date | null;
  effectiveEnd: Date | null;
  isLastBidExtension: boolean | null;
  lastBidExtensionWindow: number | null;
  lastBidExtensionInterval: number | null;
  lastBidExtensionCountMax: number | null;
  lastBidExtensionCount: number;
};

/** Auditor chronology: prerequisites must be strictly before the correction bid. */
export const CORRECTION_TNC_BEFORE_BID_MICROSECONDS = 2;
export const CORRECTION_MAP_BEFORE_BID_MICROSECONDS = 1;
/** New-price correction: place just after the latest ledger bid (SQL interval). */
export const CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS = 10;

/**
 * Synthetic correction bid time for new-price settlement:
 * - with a ledger: last bid (+ {@link CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS}
 *   at write time via SQL; Date can't represent sub-ms so validation uses last)
 * - empty ledger: just before effective end, outside the anti-snipe window
 * Must be strictly before effective end and must not land inside the last-bid
 * anti-snipe window (would have triggered an extension).
 */
export function resolveCorrectionBidCreatedAt(
  input: CorrectionBidTimestampInput,
):
  | {
      ok: true;
      createdAt: Date;
      /** Apply this offset in SQL when writing (`interval 'N microseconds'`). */
      afterLastBidMicroseconds: number;
    }
  | { ok: false; message: string } {
  const effectiveEnd = input.effectiveEnd;
  if (effectiveEnd == null || Number.isNaN(effectiveEnd.getTime())) {
    return {
      ok: false,
      message: AuctionsValidationMessages.CORRECTION_BID_TIMESTAMP_INVALID,
    };
  }

  let createdAt: Date;
  let afterLastBidMicroseconds = 0;
  if (input.lastBidCreatedAt != null) {
    // JS Date is ms-precision; write path adds CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS.
    createdAt = input.lastBidCreatedAt;
    afterLastBidMicroseconds = CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS;
  } else {
    const windowSec =
      input.isLastBidExtension === true &&
      input.lastBidExtensionWindow != null &&
      input.lastBidExtensionWindow > 0 &&
      input.lastBidExtensionInterval != null &&
      input.lastBidExtensionInterval > 0 &&
      input.lastBidExtensionCountMax != null &&
      input.lastBidExtensionCountMax > 0 &&
      input.lastBidExtensionCount < input.lastBidExtensionCountMax
        ? input.lastBidExtensionWindow
        : 0;
    const bufferSec = windowSec > 0 ? windowSec + 1 : 1;
    createdAt = new Date(effectiveEnd.getTime() - bufferSec * 1000);
  }

  if (!(createdAt.getTime() < effectiveEnd.getTime())) {
    return {
      ok: false,
      message: AuctionsValidationMessages.CORRECTION_BID_TIMESTAMP_INVALID,
    };
  }

  const timeLeftSec = Math.floor(
    (effectiveEnd.getTime() - createdAt.getTime()) / 1000,
  );
  if (
    shouldLastBidExtension({
      isLastBidExtension: input.isLastBidExtension,
      lastBidExtensionWindow: input.lastBidExtensionWindow,
      lastBidExtensionInterval: input.lastBidExtensionInterval,
      lastBidExtensionCountMax: input.lastBidExtensionCountMax,
      lastBidExtensionCount: input.lastBidExtensionCount,
      timeLeftSec,
      hasEffectiveEnd: true,
    })
  ) {
    return {
      ok: false,
      message: AuctionsValidationMessages.CORRECTION_BID_TIMESTAMP_INVALID,
    };
  }

  return { ok: true, createdAt, afterLastBidMicroseconds };
}

/**
 * Same-price winner transfer: place the correction bid just before the current
 * top standing bid so created_at ASC tie-break awards the new bidder.
 * Prefer SQL `created_at - interval '1 microsecond'` at write time; this helper
 * uses -1ms for JS Date (ms precision) when needed by callers/tests.
 */
export function resolveSamePriceCorrectionBidCreatedAt(
  topStandingBidCreatedAt: Date,
): { ok: true; createdAt: Date } | { ok: false; message: string } {
  const ms = topStandingBidCreatedAt.getTime();
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      message: AuctionsValidationMessages.CORRECTION_BID_TIMESTAMP_INVALID,
    };
  }
  return { ok: true, createdAt: new Date(ms - 1) };
}

/** Settlement winner must appear on `clients.bidders` for the auction client. */
export function isWinnerInClientBidders(
  clientBidders: number[] | null | undefined,
  winnerBidderId: number,
): boolean {
  return (clientBidders ?? []).includes(winnerBidderId);
}

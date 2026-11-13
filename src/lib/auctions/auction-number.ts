import { AuctionsValidationMessages } from "@auctionit/messages/auctions";

const AUCTION_NUMBER_MAX_LENGTH = 50;

/**
 * Build the stored auction number by prepending the client's auction_prefix.
 * Idempotent: if `input` already starts with `prefix`, it is returned unchanged.
 *
 * All whitespace is stripped (not just trimmed) so visually-identical numbers
 * like "FA-24" and "FA- 24" normalize to the same stored value and are caught
 * by the duplicate-auction-number check instead of silently coexisting.
 */
export function buildAuctionNumber(
  prefix: string | null | undefined,
  input: string | null | undefined,
): string | null {
  const normalizedInput = (input ?? "").replace(/\s+/g, "");
  const normalizedPrefix = (prefix ?? "").replace(/\s+/g, "");

  if (!normalizedInput && !normalizedPrefix) return null;

  let result: string;
  if (!normalizedPrefix) {
    result = normalizedInput;
  } else if (!normalizedInput) {
    result = normalizedPrefix;
  } else if (normalizedInput.startsWith(normalizedPrefix)) {
    result = normalizedInput;
  } else {
    result = `${normalizedPrefix}${normalizedInput}`;
  }

  if (result.length > AUCTION_NUMBER_MAX_LENGTH) {
    throw new Error(AuctionsValidationMessages.AUCTION_NUMBER_TOO_LONG);
  }

  return result || null;
}

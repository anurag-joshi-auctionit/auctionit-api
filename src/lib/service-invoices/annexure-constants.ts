import type { ImportHeaderDef } from "@auctionit/xlsx-import/types";
import {
  WINNER_LABEL,
  type WinnerRankLabel,
} from "@auctionit/lib/winner-rank";

export const SI_ANNEXURE_MAX_ROWS = 2_000;
export const SI_ANNEXURE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SI_PDF_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SI_ANNEXURE_SHEET = "Annexure";
export const SI_ANNEXURE_AMOUNT_TOLERANCE = 0.01;

/** Canonical annexure rank label (always Winning). */
export type SiAnnexureRank = WinnerRankLabel;

/** Legacy workbook rank headers still accepted on import. */
export type SiAnnexureLegacyRank = "H1" | "L1" | "H1/L1";

export type SiAnnexureParseRank = SiAnnexureRank | SiAnnexureLegacyRank;

export const SI_ANNEXURE_STATIC_HEADERS = [
  "Auction No.",
  "Auction Date",
  "Lot No.",
  "Product",
  "Approved Qty.",
  "Unit",
] as const;

export const SI_ANNEXURE_TRAILING_HEADERS = [
  "Lifted Qty.",
  "Amount",
] as const;

export const SI_ANNEXURE_PRICE_HEADER = `${WINNER_LABEL} Price` as const;
export const SI_ANNEXURE_BIDDER_HEADER = `${WINNER_LABEL} Bidder` as const;

/** Full header row for templates / generated xlsx (always Winning). */
export function siAnnexureHeaderKeys(
  _rank?: SiAnnexureParseRank,
): readonly string[] {
  return [
    ...SI_ANNEXURE_STATIC_HEADERS,
    SI_ANNEXURE_PRICE_HEADER,
    SI_ANNEXURE_BIDDER_HEADER,
    ...SI_ANNEXURE_TRAILING_HEADERS,
  ];
}

/** Default headers — Download Template / generated workbooks. */
export const SI_ANNEXURE_HEADER_KEYS = siAnnexureHeaderKeys();

export type SiAnnexureHeaderKey = (typeof SI_ANNEXURE_HEADER_KEYS)[number];

/** Fixed columns always required (Price/Bidder resolved separately). */
export const SI_ANNEXURE_FIXED_REQUIRED_HEADERS = [
  ...SI_ANNEXURE_STATIC_HEADERS,
  ...SI_ANNEXURE_TRAILING_HEADERS,
] as const;

export function siAnnexureTemplateHeaders(
  _rank?: SiAnnexureParseRank,
): ReadonlyArray<ImportHeaderDef<string>> {
  return siAnnexureHeaderKeys().map((label) => ({
    // Annexure parse keys are the display labels themselves.
    key: label,
    label,
    width: label === "Product" || label.endsWith(" Bidder") ? 28 : 16,
  }));
}

export const SI_ANNEXURE_TEMPLATE_HEADERS = siAnnexureTemplateHeaders();

/** @deprecated Prefer {@link SI_ANNEXURE_FIXED_REQUIRED_HEADERS} + Price/Bidder. */
export const SI_ANNEXURE_REQUIRED_HEADERS = SI_ANNEXURE_HEADER_KEYS;

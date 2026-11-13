import { extname } from "node:path";

export const BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE = 4;

/** Pending bank-change cheque uploads — not written to document logs until verify. */
export const CANCELLED_CHEQUE_PENDING_PREFIX = "cancelled_cheque_pending_";

/**
 * Legacy OnlineRegistration upload field prefixes (RegisterationSaveDoc).
 * Additional document types 8+ use custom stems in some rows; these prefixes
 * are the canonical values for new uploads in auctionit-new.
 */
export const LEGACY_BIDDER_DOCUMENT_TYPE_PREFIXES: Record<number, string> = {
  1: "pan_card_",
  2: "proof_of_address_",
  3: "gstin_",
  4: "cancelled_cheque_",
  5: "others_",
  6: "pollution_certificate_",
  7: "registration_certificate_",
  8: "excel_",
  9: "email_",
  10: "partnership_firm_",
  11: "moa_",
};

export function legacyBidderDocumentTypePrefix(
  documentTypeId: number,
): string {
  return LEGACY_BIDDER_DOCUMENT_TYPE_PREFIXES[documentTypeId] ?? "document_";
}

/**
 * Pending → live cancelled-cheque storage name (same `bidders/` folder).
 * e.g. `cancelled_cheque_pending_12_….jpg` → `cancelled_cheque_12_….jpg`
 */
export function pendingCancelledChequeToLiveFileName(
  pendingFileName: string,
): string {
  const livePrefix = legacyBidderDocumentTypePrefix(
    BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE,
  );
  if (
    pendingFileName
      .toLowerCase()
      .startsWith(CANCELLED_CHEQUE_PENDING_PREFIX.toLowerCase())
  ) {
    return (
      livePrefix + pendingFileName.slice(CANCELLED_CHEQUE_PENDING_PREFIX.length)
    );
  }
  return pendingFileName;
}

export function bidderDocumentFileNameHasPrefix(
  fileName: string,
  prefix: string,
): boolean {
  if (!fileName || !prefix) return false;
  return fileName.toLowerCase().startsWith(prefix.toLowerCase());
}

/** R2 / CDN storage name: `{prefix}{bidderId}.{ext}` — later uploads overwrite the same key. */
export function buildBidderR2StorageFileName(opts: {
  prefix: string;
  bidderId: number;
  originalFileName: string;
}): string {
  const ext = extname(opts.originalFileName).toLowerCase() || ".bin";
  const prefix = opts.prefix.endsWith("_") ? opts.prefix : `${opts.prefix}_`;
  return `${prefix}${opts.bidderId}${ext}`;
}

/**
 * UTC Unix epoch milliseconds as a numeric string — compact, sortable, timezone-safe.
 * e.g. `1782719623402`
 */
export function bidderDocumentEpochMs(date: Date = new Date()): string {
  return date.getTime().toString();
}

/**
 * Standard storage pattern: `{prefix}{bidderId}_{epochMs}{ext}`
 * e.g. `excel_6059_1782719623402.xls`
 */
export function buildBidderDocumentFileName(opts: {
  prefix: string;
  bidderId: number;
  uniquePart: string;
  originalFileName: string;
}): string {
  const ext = extname(opts.originalFileName).toLowerCase() || ".bin";
  const prefix = opts.prefix.endsWith("_") ? opts.prefix : `${opts.prefix}_`;
  return `${prefix}${opts.bidderId}_${opts.uniquePart}${ext}`;
}

/** New upload / seed storage name — UTC epoch-ms unique part. */
export function buildNewBidderDocumentFileName(opts: {
  prefix: string;
  bidderId: number;
  originalFileName: string;
  at?: Date;
}): string {
  return buildBidderDocumentFileName({
    prefix: opts.prefix,
    bidderId: opts.bidderId,
    uniquePart: bidderDocumentEpochMs(opts.at ?? new Date()),
    originalFileName: opts.originalFileName,
  });
}

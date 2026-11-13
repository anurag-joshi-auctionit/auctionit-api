import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import type { ParsedAuctionLotImportRow } from "./auction-lot-import-parse.js";
import type { ImportRowIssue } from "./auction-lot-import-types.js";

/** Stable key so 1, 1.0, and "1.000" collide as the same display order. */
export function normalizeDisplayOrderKey(
  displayOrder: number | string,
): string {
  return String(Number(displayOrder));
}

export function assertDisplayOrderAvailable(
  existingKeys: Set<string>,
  displayOrder: number | string,
): void {
  if (existingKeys.has(normalizeDisplayOrderKey(displayOrder))) {
    throw new Error(
      AuctionsValidationMessages.DISPLAY_ORDER_DUPLICATE_IN_AUCTION,
    );
  }
}

export function dedupeRowsByDisplayOrder(
  rows: ParsedAuctionLotImportRow[],
): {
  unique: ParsedAuctionLotImportRow[];
  skippedIssues: ImportRowIssue[];
} {
  const byDisplayOrder = new Map<string, ParsedAuctionLotImportRow>();
  const skippedIssues: ImportRowIssue[] = [];

  for (const row of rows) {
    const key = normalizeDisplayOrderKey(row.data.displayOrder);
    const existing = byDisplayOrder.get(key);
    if (existing) {
      if (row.rowNumber > existing.rowNumber) {
        skippedIssues.push({
          rowNumber: existing.rowNumber,
          kind: "skipped",
          reason: AuctionsValidationMessages.DUPLICATE_DISPLAY_ORDER_IN_FILE(
            row.rowNumber,
          ),
        });
        byDisplayOrder.set(key, row);
      } else {
        skippedIssues.push({
          rowNumber: row.rowNumber,
          kind: "skipped",
          reason: AuctionsValidationMessages.DUPLICATE_DISPLAY_ORDER_IN_FILE(
            existing.rowNumber,
          ),
        });
      }
      continue;
    }
    byDisplayOrder.set(key, row);
  }

  return {
    unique: [...byDisplayOrder.values()].sort(
      (a, b) => a.rowNumber - b.rowNumber,
    ),
    skippedIssues,
  };
}

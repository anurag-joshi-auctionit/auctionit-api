import {
  columnRangeFrom,
  ignoreNumberStoredAsText,
} from "@auctionit/xlsx-export";
import {
  LOT_BIDDER_MAP_IMPORT_SHEET,
  LOT_BIDDER_MAP_IMPORT_TEMPLATE_HEADERS,
  type LotBidderMapImportHeaderKey,
} from "../lib/lot-bidder-map-import/constants.js";
import {
  createImportWorkbook,
  workbookToBuffer,
} from "../lib/import/template-builder.js";
import type { LotBidderMapExportRow } from "./auctions.service.js";

export function buildLotBidderMapExportFilename(auctionId: number): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `auction-${auctionId}-lot-bidder-map-export-${stamp}.xlsx`;
}

/**
 * Builds an xlsx with the exact same header row/sheet name as the import
 * template, pre-filled with the auction's current attachments, so it can be
 * fed straight back into the Import Bidders flow (e.g. after a reopen).
 */
export async function buildLotBidderMapExportXlsx(
  rows: LotBidderMapExportRow[],
): Promise<Buffer> {
  const { workbook, sheet } = createImportWorkbook({
    sheetName: LOT_BIDDER_MAP_IMPORT_SHEET,
    headers: LOT_BIDDER_MAP_IMPORT_TEMPLATE_HEADERS,
  });

  const keyToCol = new Map(
    LOT_BIDDER_MAP_IMPORT_TEMPLATE_HEADERS.map((h, i) => [
      h.key as LotBidderMapImportHeaderKey,
      i + 1,
    ]),
  );

  rows.forEach((row, i) => {
    const sheetRow = sheet.getRow(i + 2);
    sheetRow.getCell(keyToCol.get("bidderId")!).value = row.bidderId;
    sheetRow.getCell(keyToCol.get("bidderName")!).value = row.bidderName;
    sheetRow.getCell(keyToCol.get("lotDisplayOrders")!).value =
      row.lotDisplayOrders.join(", ");
    sheetRow.getCell(keyToCol.get("emdDisplayOrders")!).value =
      row.emdDisplayOrders.join(", ");
    sheetRow.getCell(keyToCol.get("isEmdWithClient")!).value = row
      .isEmdWithClient
      ? "y"
      : "n";
    sheetRow.commit();
  });

  const buffer = await workbookToBuffer(workbook);

  // Lot/EMD Display Orders are text columns (comma-separated), but a single
  // value looks like a plain number to Excel, which then flags it with a
  // "Number Stored as Text" warning. Suppress it on both columns.
  return ignoreNumberStoredAsText(buffer, {
    [LOT_BIDDER_MAP_IMPORT_SHEET]: [
      columnRangeFrom(keyToCol.get("lotDisplayOrders")!, 2),
      columnRangeFrom(keyToCol.get("emdDisplayOrders")!, 2),
    ],
  });
}

import type ExcelJS from "exceljs";
import { LOADING_SCOPE_LABELS, isLoadingScope } from "@auctionit/lib/loading-scope";
import { columnRangeFrom, ignoreNumberStoredAsText } from "@auctionit/xlsx-export";
import {
  AUCTION_LOT_IMPORT_SHEET,
  auctionLotImportTemplateHeaders,
  type AuctionLotImportHeaderKey,
} from "../lib/auction-lot-import-constants.js";
import {
  createImportWorkbook,
  workbookToBuffer,
} from "../lib/import/template-builder.js";
import type { PgLotExportRow } from "./auctions-pg.service.js";

/** Row shape shared by the Lot Settings export and the staging-review export. */
export type AuctionLotExportRowData = {
  displayOrder: number | null;
  lotNumber: string | null;
  materialLiftingDays: number | null;
  plantLocation: string | null;
  materialLocation: string | null;
  startBidPrice: number | null;
  bidIncrement: number | null;
  bidLimit: number | null;
  quantity: number | null;
  uom: string | null;
  lotStartTime: string | null;
  lotEndTime: string | null;
  /** `"<item name>@@<item id>"`, or null when no item is matched yet. */
  itemLabel: string | null;
  materialDescription: string | null;
  materialName: string | null;
  /** `"<material>@@<location>"`, or null. */
  benchmarkMaterial: string | null;
  gstPercentage: number | null;
  tcsPercentage: number | null;
  loadingScope: string | null;
  remark: string | null;
};

export function buildAuctionLotExportFilename(auctionId: number): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `auction-${auctionId}-lots-export-${stamp}.xlsx`;
}

export function buildLotImportStagingExportFilename(
  auctionId: number,
  stagingId: string,
): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `auction-${auctionId}-lots-import-review-${stagingId}-${stamp}.xlsx`;
}

export function toAuctionLotExportRowData(
  row: PgLotExportRow,
): AuctionLotExportRowData {
  return {
    displayOrder: row.displayOrder,
    lotNumber: row.lotNumber,
    materialLiftingDays: row.materialLiftingDays,
    plantLocation: row.plantLocationName,
    materialLocation: row.materialLocationName,
    startBidPrice: row.startBidPrice,
    bidIncrement: row.bidIncrement,
    bidLimit: row.bidLimit,
    quantity: row.quantity,
    uom: row.uomCode,
    lotStartTime: row.lotStartTime,
    lotEndTime: row.lotEndTime,
    itemLabel:
      row.itemId != null ? `${row.itemName ?? ""}@@${row.itemId}` : null,
    materialDescription: row.materialDescription,
    materialName: row.materialName,
    benchmarkMaterial: row.benchmarkMaterial,
    gstPercentage: row.gstPercentage,
    tcsPercentage: row.tcsPercentage,
    loadingScope: isLoadingScope(row.loadingScope)
      ? LOADING_SCOPE_LABELS[row.loadingScope]
      : null,
    remark: row.remark,
  };
}

function writeAuctionLotExportRow(
  sheetRow: ExcelJS.Row,
  keyToCol: Map<AuctionLotImportHeaderKey, number>,
  row: AuctionLotExportRowData,
) {
  const set = (
    key: AuctionLotImportHeaderKey,
    value: string | number | null,
  ) => {
    const col = keyToCol.get(key);
    if (col) sheetRow.getCell(col).value = value;
  };
  set("displayOrder", row.displayOrder);
  set("lotNumber", row.lotNumber);
  set("materialLiftingDays", row.materialLiftingDays);
  set("plantLocation", row.plantLocation);
  set("materialLocation", row.materialLocation);
  set("startBidPrice", row.startBidPrice);
  set("bidIncrement", row.bidIncrement);
  set("bidLimit", row.bidLimit);
  set("quantity", row.quantity);
  set("uom", row.uom);
  set("lotStartTime", row.lotStartTime);
  set("lotEndTime", row.lotEndTime);
  set("itemId", row.itemLabel);
  set("materialDescription", row.materialDescription);
  set("materialName", row.materialName);
  set("benchmarkMaterial", row.benchmarkMaterial);
  set("gstPercentage", row.gstPercentage);
  set("tcsPercentage", row.tcsPercentage);
  set("loadingScope", row.loadingScope);
  set("remark", row.remark);
}

/**
 * Builds an xlsx with the exact same header row/sheet name as the lots
 * import template, pre-filled with the given rows, so it can be fed
 * straight back into the Import Lots flow.
 */
export async function buildAuctionLotRowsXlsx(
  rows: AuctionLotExportRowData[],
  auctionType: string | null,
): Promise<Buffer> {
  const headers = auctionLotImportTemplateHeaders(auctionType);
  const { workbook, sheet } = createImportWorkbook({
    sheetName: AUCTION_LOT_IMPORT_SHEET,
    headers,
  });

  const keyToCol = new Map(headers.map((h, i) => [h.key, i + 1]));

  rows.forEach((row, i) => {
    const sheetRow = sheet.getRow(i + 2);
    writeAuctionLotExportRow(sheetRow, keyToCol, row);
    sheetRow.commit();
  });

  const buffer = await workbookToBuffer(workbook);

  // Item ID / Benchmark Material look like plain numbers/text to Excel but
  // are deliberately text (the "<name>@@<id>" suffix convention); suppress
  // the "Number Stored as Text" warning on both columns.
  return ignoreNumberStoredAsText(buffer, {
    [AUCTION_LOT_IMPORT_SHEET]: [
      columnRangeFrom(keyToCol.get("itemId")!, 2),
      columnRangeFrom(keyToCol.get("benchmarkMaterial")!, 2),
    ],
  });
}

export async function buildAuctionLotExportXlsx(
  rows: PgLotExportRow[],
  auctionType: string | null,
): Promise<Buffer> {
  return buildAuctionLotRowsXlsx(rows.map(toAuctionLotExportRowData), auctionType);
}

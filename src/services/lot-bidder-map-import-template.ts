import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import {
  LOT_BIDDER_MAP_IMPORT_DROPDOWN_KEYS,
  LOT_BIDDER_MAP_IMPORT_SHEET,
  LOT_BIDDER_MAP_IMPORT_TEMPLATE_DATA_ROWS,
  LOT_BIDDER_MAP_IMPORT_TEMPLATE_HEADERS,
  type LotBidderMapImportHeaderKey,
} from "../lib/lot-bidder-map-import/constants.js";
import {
  createImportWorkbook,
  workbookToBuffer,
} from "../lib/import/template-builder.js";

export function buildLotBidderMapImportTemplateFilename(
  auctionId: number,
): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `auction-${auctionId}-lot-bidder-map-${stamp}.xlsx`;
}

const DROPDOWN_FORMULAE: Record<
  (typeof LOT_BIDDER_MAP_IMPORT_DROPDOWN_KEYS)[number],
  string
> = {
  isEmdWithClient: '"y,n"',
};

export async function buildLotBidderMapImportTemplateXlsx(): Promise<Buffer> {
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

  for (let r = 2; r <= LOT_BIDDER_MAP_IMPORT_TEMPLATE_DATA_ROWS + 1; r++) {
    const row = sheet.getRow(r);
    for (const key of LOT_BIDDER_MAP_IMPORT_DROPDOWN_KEYS) {
      const col = keyToCol.get(key);
      if (!col) continue;
      const cell = row.getCell(col);
      cell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [DROPDOWN_FORMULAE[key]],
        showErrorMessage: true,
        errorTitle: AuctionsValidationMessages.IMPORT_TEMPLATE_INVALID_VALUE_TITLE,
        error: AuctionsValidationMessages.IMPORT_TEMPLATE_CHOOSE_VALUE,
      };
    }
  }

  return workbookToBuffer(workbook);
}

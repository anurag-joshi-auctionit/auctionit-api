import {
  SI_ANNEXURE_BIDDER_HEADER,
  SI_ANNEXURE_PRICE_HEADER,
  SI_ANNEXURE_SHEET,
  siAnnexureHeaderKeys,
  siAnnexureTemplateHeaders,
} from "./annexure-constants.js";
import type { ServiceInvoiceAnnexureLine } from "./annexure-types.js";
import {
  createImportWorkbook,
  workbookToBuffer,
} from "../import/template-builder.js";

export function buildServiceInvoiceAnnexureTemplateFilename(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `service-invoice-annexure-${stamp}.xlsx`;
}

/** Blank template with Winning Price / Winning Bidder headers. */
export async function buildServiceInvoiceAnnexureTemplateXlsx(): Promise<Buffer> {
  const { workbook } = createImportWorkbook({
    sheetName: SI_ANNEXURE_SHEET,
    headers: siAnnexureTemplateHeaders(),
  });
  return workbookToBuffer(workbook);
}

/** Build a filled annexure workbook from preview/auto lines. */
export async function buildServiceInvoiceAnnexureXlsxFromLines(
  lines: ServiceInvoiceAnnexureLine[],
): Promise<Buffer> {
  const headers = siAnnexureHeaderKeys();
  const priceKey = SI_ANNEXURE_PRICE_HEADER;
  const bidderKey = SI_ANNEXURE_BIDDER_HEADER;

  const { workbook, sheet } = createImportWorkbook({
    sheetName: SI_ANNEXURE_SHEET,
    headers: siAnnexureTemplateHeaders(),
  });

  for (const line of lines) {
    const row: Record<string, string | number> = {
      "Auction No.": line.auctionNumber,
      "Auction Date": line.auctionDate,
      "Lot No.": line.lotNumber,
      Product: line.product,
      "Approved Qty.": line.approvedQty,
      Unit: line.uom,
      [priceKey]: line.winningPrice,
      [bidderKey]: line.bidderName,
      "Lifted Qty.": line.liftedQty,
      Amount: line.amount,
    };
    sheet.addRow(headers.map((k) => row[k]));
  }

  return workbookToBuffer(workbook);
}

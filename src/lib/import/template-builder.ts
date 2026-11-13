import ExcelJS from "exceljs";
import type { ImportHeaderDef } from "@auctionit/xlsx-import/types";

export type BuildImportWorkbookOptions = {
  sheetName: string;
  headers: readonly ImportHeaderDef[];
  freezeHeader?: boolean;
  creator?: string;
};

/**
 * Shared ExcelJS skeleton: workbook meta + frozen bold header row from display labels.
 */
export function createImportWorkbook(
  options: BuildImportWorkbookOptions,
): {
  workbook: ExcelJS.Workbook;
  sheet: ExcelJS.Worksheet;
} {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = options.creator ?? "AuctionIT Admin";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(options.sheetName, {
    views: options.freezeHeader === false ? undefined : [{ state: "frozen", ySplit: 1 }],
  });

  const headerRow = sheet.getRow(1);
  options.headers.forEach((h, index) => {
    const col = index + 1;
    const cell = headerRow.getCell(col);
    cell.value = h.label;
    cell.font = { bold: true };
    sheet.getColumn(col).width = h.width;
  });
  headerRow.commit();

  return { workbook, sheet };
}

export async function workbookToBuffer(
  workbook: ExcelJS.Workbook,
): Promise<Buffer> {
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

import ExcelJS from "exceljs";
import {
  columnRangeFrom,
  ignoreNumberStoredAsText,
} from "./ignore-number-as-text.js";
import { writeReportHeader } from "./report-header.js";
import type { BuildRowsXlsxOptions } from "./types.js";

const DEFAULT_COLUMN_WIDTH = 16;

/**
 * Build an .xlsx buffer from a fixed column map and row list.
 * Header row is bold and frozen by default. When `title` is set, the title
 * and "Report generated at" lines occupy rows 1–2 and the header moves to row 3.
 */
export async function buildRowsXlsx<T>(
  options: BuildRowsXlsxOptions<T>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = options.creator ?? "AuctionIT";
  workbook.created = new Date();

  const headerRowNumber = options.title != null ? 3 : 1;

  const sheet = workbook.addWorksheet(options.sheetName, {
    views:
      options.freezeHeader === false
        ? undefined
        : [{ state: "frozen", ySplit: headerRowNumber }],
  });

  if (options.title != null) {
    writeReportHeader(sheet, {
      title: options.title,
      generatedAt: options.generatedAt,
      columnCount: options.columns.length,
      columnWidths: options.columns.map((c) => c.width ?? DEFAULT_COLUMN_WIDTH),
    });
  }

  const headerRow = sheet.getRow(headerRowNumber);
  options.columns.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.header;
    cell.font = { bold: true };
    sheet.getColumn(index + 1).width = col.width ?? DEFAULT_COLUMN_WIDTH;
  });
  headerRow.commit();

  options.rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(headerRowNumber + 1 + rowIndex);
    options.columns.forEach((col, colIndex) => {
      const raw = col.value(row);
      excelRow.getCell(colIndex + 1).value = raw ?? null;
    });
    excelRow.commit();
  });

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const textRanges = options.columns.flatMap((col, i) =>
    col.asText ? [columnRangeFrom(i + 1, headerRowNumber + 1)] : [],
  );
  return ignoreNumberStoredAsText(buffer, { [options.sheetName]: textRanges });
}

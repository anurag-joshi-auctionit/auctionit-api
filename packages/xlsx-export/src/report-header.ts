import type ExcelJS from "exceljs";

const GENERATED_AT_LABEL = "Report generated at";

export type WriteReportHeaderOptions = {
  title: string;
  generatedAt: string;
  columnCount: number;
  /** Column widths (Excel units); used to size wrapped rows so text isn't clipped. */
  columnWidths?: readonly number[];
};

const TITLE_FONT_SIZE = 18;
const TITLE_LINE_HEIGHT = 24;
const BODY_FONT_SIZE = 11;
const BODY_LINE_HEIGHT = 15;

/** Estimated wrapped row height; Excel does not auto-fit merged cells. */
function wrappedHeight(
  text: string,
  widths: readonly number[] | undefined,
  fontSize: number,
  lineHeight: number,
  bold: boolean,
): number | undefined {
  if (!widths || widths.length === 0) return undefined;
  const total = widths.reduce((sum, w) => sum + w, 0);
  // Column width units ≈ characters at 11pt; bold glyphs are slightly wider.
  const charsPerLine = Math.max(
    1,
    Math.floor((total * BODY_FONT_SIZE) / (fontSize * (bold ? 1.1 : 1))),
  );
  return Math.max(1, Math.ceil(text.length / charsPerLine)) * lineHeight;
}

function mergeRow(sheet: ExcelJS.Worksheet, rowNumber: number, columnCount: number) {
  if (columnCount > 1) {
    sheet.mergeCells(rowNumber, 1, rowNumber, columnCount);
  }
}

/** Writes the merged, centred "Report generated at …" line on `rowNumber`. */
export function writeGeneratedAtRow(
  sheet: ExcelJS.Worksheet,
  options: {
    rowNumber: number;
    generatedAt: string;
    columnCount: number;
    columnWidths?: readonly number[];
  },
): void {
  mergeRow(sheet, options.rowNumber, options.columnCount);
  const cell = sheet.getCell(options.rowNumber, 1);
  const text = `${GENERATED_AT_LABEL} ${options.generatedAt}`;
  cell.value = text;
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  const height = wrappedHeight(
    text,
    options.columnWidths,
    BODY_FONT_SIZE,
    BODY_LINE_HEIGHT,
    false,
  );
  if (height != null) sheet.getRow(options.rowNumber).height = height;
}

/**
 * Writes the report title (row 1) and "Report generated at" (row 2), both
 * merged across `columnCount` columns. Returns the next free row number.
 */
export function writeReportHeader(
  sheet: ExcelJS.Worksheet,
  options: WriteReportHeaderOptions,
): number {
  mergeRow(sheet, 1, options.columnCount);
  const title = sheet.getCell(1, 1);
  title.value = options.title;
  title.font = { bold: true, size: TITLE_FONT_SIZE };
  title.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  const titleHeight = wrappedHeight(
    options.title,
    options.columnWidths,
    TITLE_FONT_SIZE,
    TITLE_LINE_HEIGHT,
    true,
  );
  if (titleHeight != null) sheet.getRow(1).height = titleHeight;

  writeGeneratedAtRow(sheet, {
    rowNumber: 2,
    generatedAt: options.generatedAt,
    columnCount: options.columnCount,
    columnWidths: options.columnWidths,
  });
  return 3;
}

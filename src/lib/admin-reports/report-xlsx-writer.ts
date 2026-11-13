import { PassThrough } from "node:stream";
import { formatDate } from "@auctionit/lib/date";
import {
  columnRangeFrom,
  ignoreNumberStoredAsText,
  injectSheetLogo,
} from "@auctionit/xlsx-export";
import ExcelJS from "exceljs";
import { BRAND_LOGO_SIZE_PX, readBrandLogo } from "../brand-logo.js";

/**
 * Streaming workbook writer shared by the background-job reports (Revenue, Lifting):
 * logo + title in row 1, generated-at in row 2, frozen header in row 3.
 */

export type CellKind = "text" | "date" | "datetime" | "month" | "qty" | "money" | "int";

export type ReportColumn<T> = {
  header: string;
  width: number;
  kind: CellKind;
  value: (row: T) => string | number | null;
};

export type ReportSheet<T> = {
  name: string;
  title: string;
  columns: ReportColumn<T>[];
  rows: T[];
  freezeColumns?: number;
  onStart?: () => void;
  onRows?: (written: number, total: number) => void;
};

const HEADER_ROW = 3;
const TITLE_ROW_HEIGHT = 48;
const LOGO_HEIGHT_PX = 60;
const LOGO_WIDTH_PX = Math.round(
  (LOGO_HEIGHT_PX * BRAND_LOGO_SIZE_PX.width) / BRAND_LOGO_SIZE_PX.height,
);
const PROGRESS_EVERY_ROWS = 2000;
const GENERATED_AT_LABEL = "Report generated at";

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF4F81BD" },
};
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

const NUM_FMT: Record<CellKind, string | undefined> = {
  text: undefined,
  date: "dd/mmm/yyyy",
  datetime: "dd/mmm/yyyy hh:mm",
  month: "mmm yyyy",
  qty: "#,##0.00",
  money: "#,##0.00",
  int: "0",
};

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** `YYYY-MM-DD` / IST wall-clock `YYYY-MM-DDTHH:MM:SS` → Date whose UTC parts match (exceljs writes UTC). */
function toExcelDate(value: string): Date | null {
  const iso = value.length <= 10 ? `${value}T00:00:00Z` : `${value.slice(0, 19)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cellValue(kind: CellKind, raw: string | number | null): ExcelJS.CellValue {
  if (raw == null || raw === "") return null;
  if (kind === "date" || kind === "datetime" || kind === "month") {
    return typeof raw === "string" ? toExcelDate(raw) : null;
  }
  return raw;
}

function styleCell(cell: ExcelJS.Cell, kind: CellKind) {
  const numFmt = NUM_FMT[kind];
  if (numFmt) cell.numFmt = numFmt;
  cell.border = THIN_BORDER;
  if (kind !== "text") cell.alignment = { horizontal: "right" };
}

function writeTitleBlock(
  sheet: ExcelJS.Worksheet,
  title: string,
  generatedAt: string,
  columnCount: number,
) {
  sheet.mergeCells(1, 1, 1, columnCount);
  const titleRow = sheet.getRow(1);
  titleRow.height = TITLE_ROW_HEIGHT;
  const titleCell = titleRow.getCell(1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleRow.commit();

  sheet.mergeCells(2, 1, 2, columnCount);
  const generatedRow = sheet.getRow(2);
  const generatedCell = generatedRow.getCell(1);
  generatedCell.value = `${GENERATED_AT_LABEL} ${generatedAt}`;
  generatedCell.alignment = { horizontal: "center", vertical: "middle" };
  generatedRow.commit();
}

function writeHeaderRow<T>(sheet: ExcelJS.Worksheet, columns: ReportColumn<T>[]) {
  const row = sheet.getRow(HEADER_ROW);
  columns.forEach((col, i) => {
    const cell = row.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.border = THIN_BORDER;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  row.commit();
}

function writeDataRow<T>(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  columns: ReportColumn<T>[],
  data: T,
) {
  const row = sheet.getRow(rowNumber);
  columns.forEach((col, i) => {
    const cell = row.getCell(i + 1);
    cell.value = cellValue(col.kind, col.value(data));
    styleCell(cell, col.kind);
  });
  row.commit();
}

function columnLetter(index: number): string {
  let n = index;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function writeSheet<T>(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  spec: ReportSheet<T>,
  generatedAt: string,
) {
  const { columns, rows } = spec;
  spec.onStart?.();
  const sheet = workbook.addWorksheet(spec.name, {
    views: [
      {
        state: "frozen",
        ySplit: HEADER_ROW,
        xSplit: spec.freezeColumns ?? 0,
      },
    ],
  });
  sheet.columns = columns.map((c) => ({ width: c.width }));
  sheet.autoFilter = `A${HEADER_ROW}:${columnLetter(columns.length)}${HEADER_ROW}`;

  writeTitleBlock(sheet, spec.title, generatedAt, columns.length);
  writeHeaderRow(sheet, columns);

  let rowNumber = HEADER_ROW + 1;
  for (let i = 0; i < rows.length; i++) {
    writeDataRow(sheet, rowNumber++, columns, rows[i]!);
    if ((i + 1) % PROGRESS_EVERY_ROWS === 0) {
      spec.onRows?.(i + 1, rows.length);
      await yieldToEventLoop();
    }
  }
  spec.onRows?.(rows.length, rows.length);
  sheet.commit();
}

/** Keeps each sheet's row type while letting sheets of different types share one array. */
export function reportSheet<T>(spec: ReportSheet<T>): ReportSheet<unknown> {
  return spec as ReportSheet<unknown>;
}

export async function buildReportWorkbook(
  sheets: ReportSheet<unknown>[],
  options: { generatedAt: string; onLogo?: () => void },
): Promise<Buffer> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = "AuctionIt";
  workbook.created = new Date();

  for (const spec of sheets) {
    await writeSheet(workbook, spec, options.generatedAt);
  }

  await workbook.commit();
  await finished;
  const streamed = await ignoreNumberStoredAsText(
    Buffer.concat(chunks),
    Object.fromEntries(
      sheets.map((s) => [
        s.name,
        s.columns.flatMap((col, i) =>
          col.kind === "text" ? [columnRangeFrom(i + 1, HEADER_ROW + 1)] : [],
        ),
      ]),
    ),
  );

  const logo = readBrandLogo();
  if (!logo) return streamed;
  options.onLogo?.();
  return injectSheetLogo(streamed, {
    image: logo,
    sheetNames: sheets.map((s) => s.name),
    widthPx: LOGO_WIDTH_PX,
    heightPx: LOGO_HEIGHT_PX,
  });
}

/** e.g. `RevenueReport_01Apr2024_to_28Sep2026.xlsx`. */
export function buildDateRangeReportFilename(
  prefix: string,
  from: string,
  to: string,
): string {
  const compact = (iso: string) => formatDate(iso).replace(/\s+/g, "");
  return `${prefix}_${compact(from)}_to_${compact(to)}.xlsx`;
}

import PDFDocument from "pdfkit";
import type { ServiceFeeType } from "@auctionit/messages/clients";
import {
  PDF_FONT_BOLD,
  PDF_FONT_REGULAR,
  registerTimesNewRoman,
} from "../pdf-fonts.js";
import {
  SI_ANNEXURE_PRICE_HEADER,
} from "./annexure-constants.js";
import type { ServiceInvoiceAnnexureLine } from "./annexure-types.js";

export type AnnexurePdfInput = {
  lines: ServiceInvoiceAnnexureLine[];
  clientName: string;
  plantLocationName: string | null;
  totalQuantity: number;
  totalAmount: number;
  serviceFeeType: ServiceFeeType;
  serviceFeeValue: number;
  serviceFeeAmount: number;
};

/** A4 portrait */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 28;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT_SIZE = 6;
const HEADER_FONT_SIZE = 10;
const TITLE_FONT_SIZE = 8;
const CELL_PAD = 3;
const FOOTER_RESERVE = 28;
const MIN_ROW_HEIGHT = 16;
const MAX_ROW_HEIGHT = 56;

function formatNumber(n: number, decimals = 2): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Display date: DD MMM YYYY (e.g. 15 Jan 2026), matching app-wide formatDate.
 * Accepts ISO `YYYY-MM-DD` or other Date-parseable values; returns original if unparseable.
 */
export function formatAnnexureDisplayDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  let year: number;
  let month: number;
  let day: number;
  if (isoDay) {
    year = Number(isoDay[1]);
    month = Number(isoDay[2]);
    day = Number(isoDay[3]);
  } else {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return trimmed;
    year = d.getFullYear();
    month = d.getMonth() + 1;
    day = d.getDate();
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return trimmed;
  const dd = String(day).padStart(2, "0");
  return `${dd} ${MONTH_SHORT[month - 1]} ${year}`;
}

/** Fee-type Service Charges footer line. */
export function formatServiceChargesLine(
  type: ServiceFeeType,
  serviceFeeValue: number,
  serviceFeeAmount: number,
): string {
  const amount = formatNumber(serviceFeeAmount, 2);
  switch (type) {
    case "service_percentage":
      return `Service Charges @ INR ${serviceFeeValue}% = INR ${amount}`;
    case "pmt":
      return `Service Charges @ INR ${serviceFeeValue}/MT = INR ${amount}`;
    case "fixed_amount":
      return `Service Charges @ INR ${serviceFeeValue} = INR ${amount}`;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

type RowCells = {
  auctionNumber: string;
  auctionDate: string;
  lotNumber: string;
  product: string;
  approvedQty: string;
  uom: string;
  highestPrice: string;
  party: string;
  liftedQty: string;
  amount: string;
};

type ColSpec = {
  key: keyof RowCells;
  header: string;
  /** Only Auction No, Lot No, Product, Party use fixed widths. */
  fixedWidth?: number;
  align?: "left" | "right";
};

type ColDef = ColSpec & { width: number };

/**
 * Fixed widths only for Auction Number, Lot No., Product, Party.
 * Remaining columns share leftover space equally so the table is 100% of CONTENT_WIDTH.
 */
const COL_SPECS: ColSpec[] = [
  { key: "auctionNumber", header: "Auction Number", fixedWidth: 60 },
  { key: "auctionDate", header: "Auction Date" },
  { key: "lotNumber", header: "Lot No.", fixedWidth: 90 },
  { key: "product", header: "Product", fixedWidth: 60 },
  { key: "approvedQty", header: "Approved Qty.", align: "right" },
  { key: "uom", header: "Unit" },
  {
    key: "highestPrice",
    header: "Highest Price",
    align: "right",
    fixedWidth: 50,
  },
  { key: "party", header: "Party", fixedWidth: 60 },
  { key: "liftedQty", header: "Lifted Qty", align: "right", fixedWidth: 40 },
  { key: "amount", header: "Amount", align: "right", fixedWidth: 70 },
];

/** Resolve column widths to fill `contentWidth` exactly. */
export function resolveAnnexureColumnWidths(
  contentWidth: number = CONTENT_WIDTH,
): ColDef[] {
  const fixedTotal = COL_SPECS.reduce(
    (sum, col) => sum + (col.fixedWidth ?? 0),
    0,
  );
  const autoCount = COL_SPECS.filter((c) => c.fixedWidth == null).length;
  const remaining = Math.max(contentWidth - fixedTotal, autoCount * 24);
  const autoWidth = autoCount > 0 ? remaining / autoCount : 0;

  let used = 0;
  const cols: ColDef[] = COL_SPECS.map((col, index) => {
    const isLast = index === COL_SPECS.length - 1;
    let width = col.fixedWidth ?? autoWidth;
    if (isLast) {
      // Absorb rounding so widths sum exactly to contentWidth.
      width = contentWidth - used;
    } else {
      width = Math.round(width * 100) / 100;
      used += width;
    }
    return { ...col, width };
  });
  return cols;
}

function partyHeader(): string {
  return "Party (Winning)";
}

function priceHeader(): string {
  return SI_ANNEXURE_PRICE_HEADER;
}

function lineToCells(line: ServiceInvoiceAnnexureLine): RowCells {
  return {
    auctionNumber: line.auctionNumber || "",
    auctionDate: formatAnnexureDisplayDate(line.auctionDate || ""),
    lotNumber: line.lotNumber || "",
    product: line.product || "",
    approvedQty: formatNumber(line.approvedQty, 2),
    uom: line.uom || "",
    highestPrice: formatNumber(line.winningPrice, 2),
    party: line.bidderName || "",
    liftedQty: formatNumber(line.liftedQty, 2),
    amount: formatNumber(line.amount, 2),
  };
}

function measureRowHeight(
  doc: PDFKit.PDFDocument,
  cols: ColDef[],
  cells: string[],
  bold: boolean,
): number {
  doc.font(bold ? PDF_FONT_BOLD : PDF_FONT_REGULAR).fontSize(FONT_SIZE);
  let h = MIN_ROW_HEIGHT;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    const textH = doc.heightOfString(cells[i] ?? "", {
      width: Math.max(col.width - CELL_PAD * 2, 4),
    });
    h = Math.max(h, textH + CELL_PAD * 2);
  }
  return Math.min(h, MAX_ROW_HEIGHT);
}

/**
 * Draw a bordered cell. Resets PDFKit cursor after text so siblings stay aligned.
 * Always pass `height` so PDFKit clips instead of auto-inserting pages.
 */
function drawCell(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { align?: "left" | "right"; bold?: boolean },
): void {
  doc.strokeColor("#000").lineWidth(0.5);
  doc.rect(x, y, w, h).stroke();
  doc
    .font(opts.bold ? PDF_FONT_BOLD : PDF_FONT_REGULAR)
    .fontSize(FONT_SIZE)
    .fillColor("#000");
  doc.text(text, x + CELL_PAD, y + CELL_PAD, {
    width: Math.max(w - CELL_PAD * 2, 4),
    height: Math.max(h - CELL_PAD * 2, 4),
    align: opts.align ?? "left",
    lineBreak: true,
    ellipsis: true,
  });
  doc.x = x + w;
  doc.y = y;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  cols: ColDef[],
  cells: string[],
  y: number,
  bold: boolean,
  partyLabel?: string,
): number {
  const values =
    partyLabel != null
      ? cols.map((c, i) => (c.key === "party" ? partyLabel : (cells[i] ?? "")))
      : cells;
  const rowHeight = measureRowHeight(doc, cols, values, bold);
  let x = MARGIN;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    drawCell(doc, values[i] ?? "", x, y, col.width, rowHeight, {
      align: col.align,
      bold,
    });
    x += col.width;
  }
  return y + rowHeight;
}

function drawTitleBlock(
  doc: PDFKit.PDFDocument,
  input: AnnexurePdfInput,
  y: number,
): number {
  doc.fillColor("#000").font(PDF_FONT_BOLD).fontSize(HEADER_FONT_SIZE);
  doc.text("iCom Analytics Limited", MARGIN, y, {
    width: CONTENT_WIDTH,
    height: HEADER_FONT_SIZE + 4,
    lineBreak: false,
  });
  let next = y + 16;
  doc.font(PDF_FONT_REGULAR).fontSize(TITLE_FONT_SIZE);
  const plant = input.plantLocationName?.trim() || "";
  const subhead = plant
    ? `Annexure to invoice of ${input.clientName}, ${plant}`
    : `Annexure to invoice of ${input.clientName}`;
  doc.text(subhead, MARGIN, next, {
    width: CONTENT_WIDTH,
    height: TITLE_FONT_SIZE + 4,
    lineBreak: false,
  });
  doc.x = MARGIN;
  doc.y = next + 14;
  return next + 18;
}

function drawHeaderRow(
  doc: PDFKit.PDFDocument,
  cols: ColDef[],
  y: number,
): number {
  const headers = cols.map((c) => {
    if (c.key === "highestPrice") return priceHeader();
    if (c.key === "party") return partyHeader();
    return c.header;
  });
  return drawTableRow(doc, cols, headers, y, true);
}

/** Zero PDFKit margins so only our manual addPage() controls paging. */
function addAnnexurePage(doc: PDFKit.PDFDocument): void {
  doc.addPage({
    size: "A4",
    layout: "portrait",
    margins: { top: 0, left: 0, right: 0, bottom: 0 },
  });
}

function startContentPage(
  doc: PDFKit.PDFDocument,
  input: AnnexurePdfInput,
  cols: ColDef[],
  isFirst: boolean,
): number {
  if (!isFirst) addAnnexurePage(doc);
  const afterTitle = drawTitleBlock(doc, input, MARGIN);
  return drawHeaderRow(doc, cols, afterTitle);
}

/**
 * Build annexure PDF buffer (A4 portrait) from parsed lines + invoice fee fields.
 */
export async function buildAnnexurePdf(
  input: AnnexurePdfInput,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "portrait",
      // Zero margins: we position manually. Non-zero bottom margin caused
      // PDFKit to auto-insert blank pages when drawing footers/page numbers.
      margins: { top: 0, left: 0, right: 0, bottom: 0 },
      autoFirstPage: true,
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    registerTimesNewRoman(doc);

    const cols = resolveAnnexureColumnWidths(CONTENT_WIDTH);
    let y = startContentPage(doc, input, cols, true);
    const maxY = PAGE_HEIGHT - MARGIN - FOOTER_RESERVE;

    for (const line of input.lines) {
      const cells = lineToCells(line);
      const cellValues = cols.map((c) => cells[c.key]);
      const rowHeight = measureRowHeight(doc, cols, cellValues, false);
      if (y + rowHeight > maxY) {
        y = startContentPage(doc, input, cols, false);
      }
      y = drawTableRow(doc, cols, cellValues, y, false);
    }

    const totalsBlockHeight = 52;
    if (y + totalsBlockHeight > maxY) {
      addAnnexurePage(doc);
      y = drawTitleBlock(doc, input, MARGIN);
    }

    y += 10;
    doc.font(PDF_FONT_BOLD).fontSize(TITLE_FONT_SIZE).fillColor("#000");
    doc.text(
      `Total Lifted Qty: ${formatNumber(input.totalQuantity, 2)}`,
      MARGIN,
      y,
      {
        width: CONTENT_WIDTH,
        height: TITLE_FONT_SIZE + 4,
        lineBreak: false,
      },
    );
    y += 14;
    doc.text(
      `Total Amount: INR ${formatNumber(input.totalAmount, 2)}`,
      MARGIN,
      y,
      {
        width: CONTENT_WIDTH,
        height: TITLE_FONT_SIZE + 4,
        lineBreak: false,
      },
    );
    y += 14;
    doc.text(
      formatServiceChargesLine(
        input.serviceFeeType,
        input.serviceFeeValue,
        input.serviceFeeAmount,
      ),
      MARGIN,
      y,
      {
        width: CONTENT_WIDTH,
        height: TITLE_FONT_SIZE + 4,
        lineBreak: false,
      },
    );

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc
        .font(PDF_FONT_REGULAR)
        .fontSize(8)
        .fillColor("#666")
        .text(`Page ${i + 1} of ${range.count}`, MARGIN, PAGE_HEIGHT - 18, {
          width: CONTENT_WIDTH,
          align: "center",
          height: 12,
          lineBreak: false,
        });
    }

    doc.end();
  });
}

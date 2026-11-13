import PDFDocument from "pdfkit";
import { formatDate } from "@auctionit/lib/date";
import { resolveBrandLogoPath } from "../brand-logo.js";
import {
  PDF_FONT_BOLD,
  PDF_FONT_REGULAR,
  registerTimesNewRoman,
} from "../pdf-fonts.js";
import {
  formatPercent,
  formatQty,
  lotConfirmationLineAmounts,
} from "./lot-confirmation-amounts.js";

export type LotConfirmationLotRow = {
  lotNumber: string;
  plantLocationName: string;
  reviewedAt: string | null;
  materialLiftingDays: number | null;
  quantity: number;
  uom: string;
  winningAmount: number;
  gstPercentage: number;
  tcsPercentage: number;
};

export type LotConfirmationPdfInput = {
  auctionType: string | null | undefined;
  auctionNumber: string;
  auctionDate: string;
  clientName: string;
  taxLabel: "GST" | "VAT";
  bidderCompany: string;
  bidderAddress: string;
  bidderCityPin: string;
  bidderEmail: string;
  bidderPhone: string;
  bidderPan: string;
  bidderGstin: string;
  paymentContacts: string[];
  lots: LotConfirmationLotRow[];
  letterDate?: string;
};

type TextRun = { text: string; bold?: boolean };

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 28;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const HEADER_FILL = "#F9B266";
const BORDER = "#000";
const FONT_SIZE = 6.5;
const HEADER_FONT_SIZE = 6;
const BODY_FONT_SIZE = 9;
const CELL_PAD = 3;
const MIN_ROW_HEIGHT = 16;
const MAX_ROW_HEIGHT = 56;
const FOOTER_RESERVE = 24;
const FONT_REGULAR = PDF_FONT_REGULAR;
const FONT_BOLD = PDF_FONT_BOLD;
const NOTES_NUM_WIDTH = 12;

type CellKey =
  | "lotNo"
  | "plant"
  | "confirmedAt"
  | "lifting"
  | "qty"
  | "unit"
  | "price"
  | "gstPct"
  | "gstAmt"
  | "priceGst"
  | "tcsPct"
  | "tcsAmt"
  | "priceGstTcs"
  | "total";

type ColSpec = {
  key: CellKey;
  header: string;
  fixedWidth?: number;
  align: "left" | "right" | "center";
};

type ColDef = ColSpec & { width: number };

function formatNumber(n: number, decimals = 2): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function columnSpecs(taxLabel: "GST" | "VAT"): ColSpec[] {
  return [
    { key: "lotNo", header: "Lot No.", fixedWidth: 100, align: "left" },
    { key: "plant", header: "Plant Location", align: "left" },
    {
      key: "confirmedAt",
      header: "Confirmed On",
      align: "left",
      fixedWidth: 30,
    },
    { key: "lifting", header: "Lifting Period (Days)", align: "center" },
    { key: "qty", header: "Qty", align: "right" },
    { key: "unit", header: "Unit", align: "right" },
    { key: "price", header: "Winning Price", align: "right", fixedWidth: 40 },
    {
      key: "gstPct",
      header: `${taxLabel} (%)`,
      align: "right",
      fixedWidth: 20,
    },
    {
      key: "gstAmt",
      header: `${taxLabel} Amount`,
      align: "right",
      fixedWidth: 40,
    },
    {
      key: "priceGst",
      header: `Winning + ${taxLabel}`,
      align: "right",
      fixedWidth: 40,
    },
    { key: "tcsPct", header: "TCS (%)", align: "right", fixedWidth: 20 },
    { key: "tcsAmt", header: "TCS Amount", align: "right", fixedWidth: 40 },
    {
      key: "priceGstTcs",
      header: `(Winning + ${taxLabel}) + TCS`,
      align: "right",
      fixedWidth: 40,
    },
    { key: "total", header: "Total Amount", align: "right", fixedWidth: 50 },
  ];
}

/** Fixed widths for LOT No. and Plant Location; remaining columns share leftover space. */
export function resolveLotConfirmationColumnWidths(
  taxLabel: "GST" | "VAT",
  contentWidth: number = CONTENT_WIDTH,
): ColDef[] {
  const specs = columnSpecs(taxLabel);
  const fixedTotal = specs.reduce((sum, col) => sum + (col.fixedWidth ?? 0), 0);
  const autoCount = specs.filter((c) => c.fixedWidth == null).length;
  const remaining = Math.max(contentWidth - fixedTotal, autoCount * 24);
  const autoWidth = autoCount > 0 ? remaining / autoCount : 0;

  let used = 0;
  return specs.map((col, index) => {
    const isLast = index === specs.length - 1;
    let width = col.fixedWidth ?? autoWidth;
    if (isLast) {
      width = contentWidth - used;
    } else {
      width = Math.round(width * 100) / 100;
      used += width;
    }
    return { ...col, width };
  });
}

function lineToCells(lot: LotConfirmationLotRow): Record<CellKey, string> {
  const amounts = lotConfirmationLineAmounts({
    winningAmount: lot.winningAmount,
    quantity: lot.quantity,
    gstPercentage: lot.gstPercentage,
    tcsPercentage: lot.tcsPercentage,
  });
  return {
    lotNo: lot.lotNumber,
    plant: lot.plantLocationName,
    confirmedAt: formatDate(lot.reviewedAt) || "",
    lifting:
      lot.materialLiftingDays == null ? "" : String(lot.materialLiftingDays),
    qty: formatQty(lot.quantity),
    unit: lot.uom,
    price: formatNumber(amounts.price),
    gstPct: formatPercent(lot.gstPercentage),
    gstAmt: formatNumber(amounts.gstAmount),
    priceGst: formatNumber(amounts.pricePlusGst),
    tcsPct: formatPercent(lot.tcsPercentage),
    tcsAmt: formatNumber(amounts.tcsAmount),
    priceGstTcs: formatNumber(amounts.unitWithTax),
    total: formatNumber(amounts.lineTotal),
  };
}

function measureRowHeight(
  doc: PDFKit.PDFDocument,
  cols: ColDef[],
  cells: Record<CellKey, string>,
  fontSize: number,
  bold: boolean,
): number {
  doc.font(bold ? FONT_BOLD : FONT_REGULAR).fontSize(fontSize);
  let h = MIN_ROW_HEIGHT;
  for (const col of cols) {
    const textH = doc.heightOfString(cells[col.key] || " ", {
      width: Math.max(col.width - CELL_PAD * 2, 4),
    });
    h = Math.max(h, textH + CELL_PAD * 2);
  }
  return Math.min(h, MAX_ROW_HEIGHT);
}

function drawCell(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: {
    align?: "left" | "right" | "center";
    bold?: boolean;
    fontSize: number;
    fill?: string;
  },
): void {
  if (opts.fill) {
    doc.rect(x, y, w, h).fill(opts.fill);
  }
  doc.strokeColor(BORDER).lineWidth(0.4);
  doc.rect(x, y, w, h).stroke();
  doc.font(pdfBold(opts.bold)).fontSize(opts.fontSize).fillColor("#000");
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

function pdfBold(bold?: boolean): string {
  return bold ? FONT_BOLD : FONT_REGULAR;
}

function drawRow(
  doc: PDFKit.PDFDocument,
  cols: ColDef[],
  cells: Record<CellKey, string>,
  y: number,
  opts: { header?: boolean; fill?: string; fontSize: number; bold?: boolean },
): number {
  const bold = opts.bold === true || opts.header === true;
  const height = measureRowHeight(doc, cols, cells, opts.fontSize, bold);
  let x = MARGIN;
  for (const col of cols) {
    drawCell(doc, cells[col.key] || "", x, y, col.width, height, {
      align: col.align,
      bold,
      fontSize: opts.fontSize,
      fill: opts.fill,
    });
    x += col.width;
  }
  return y + height;
}

function drawTotalRow(
  doc: PDFKit.PDFDocument,
  cols: ColDef[],
  amount: string,
  y: number,
): number {
  const last = cols[cols.length - 1]!;
  const spanWidth = CONTENT_WIDTH - last.width;
  const label = "Total (Round off)";
  doc.font(FONT_REGULAR).fontSize(BODY_FONT_SIZE);
  const labelH = doc.heightOfString(label, {
    width: Math.max(spanWidth - CELL_PAD * 2, 4),
  });
  doc.font(FONT_BOLD).fontSize(FONT_SIZE);
  const amountH = doc.heightOfString(amount, {
    width: Math.max(last.width - CELL_PAD * 2, 4),
  });
  const height = Math.min(
    Math.max(MIN_ROW_HEIGHT, labelH + CELL_PAD * 2, amountH + CELL_PAD * 2),
    MAX_ROW_HEIGHT,
  );

  doc.strokeColor(BORDER).lineWidth(0.4);
  doc.rect(MARGIN, y, CONTENT_WIDTH, height).stroke();
  doc
    .moveTo(MARGIN + spanWidth, y)
    .lineTo(MARGIN + spanWidth, y + height)
    .stroke();

  doc.font(FONT_REGULAR).fontSize(BODY_FONT_SIZE).fillColor("#000");
  doc.text(label, MARGIN + CELL_PAD, y + CELL_PAD, {
    width: Math.max(spanWidth - CELL_PAD * 2, 4),
    height: Math.max(height - CELL_PAD * 2, 4),
    align: "right",
    lineBreak: false,
  });
  doc.font(FONT_BOLD).fontSize(FONT_SIZE);
  doc.text(amount, MARGIN + spanWidth + CELL_PAD, y + CELL_PAD, {
    width: Math.max(last.width - CELL_PAD * 2, 4),
    height: Math.max(height - CELL_PAD * 2, 4),
    align: "right",
    lineBreak: false,
  });
  doc.x = MARGIN;
  doc.y = y;
  return y + height;
}

function drawRuns(
  doc: PDFKit.PDFDocument,
  runs: TextRun[],
  x: number,
  y: number,
  width: number,
  size: number,
): number {
  if (runs.length === 0) return y;
  doc.fontSize(size).fillColor("#000");
  runs.forEach((run, i) => {
    const continued = i < runs.length - 1;
    doc.font(pdfBold(run.bold));
    if (i === 0) {
      doc.text(run.text, x, y, { width, continued, align: "left" });
    } else {
      doc.text(run.text, { continued });
    }
  });
  return doc.y;
}

function drawWrappedText(
  doc: PDFKit.PDFDocument,
  text: string,
  y: number,
  opts?: { bold?: boolean; size?: number; color?: string },
): number {
  doc
    .font(pdfBold(opts?.bold))
    .fontSize(opts?.size ?? BODY_FONT_SIZE)
    .fillColor(opts?.color ?? "#000")
    .text(text, MARGIN, y, { width: CONTENT_WIDTH, align: "left" });
  return doc.y;
}

function drawNotesTable(
  doc: PDFKit.PDFDocument,
  notes: TextRun[][],
  y: number,
  maxY: number,
): number {
  const textWidth = CONTENT_WIDTH - NOTES_NUM_WIDTH;
  for (let i = 0; i < notes.length; i++) {
    const runs = notes[i]!;
    const plain = runs.map((r) => r.text).join("");
    doc.font(FONT_REGULAR).fontSize(BODY_FONT_SIZE);
    const textH = doc.heightOfString(plain, { width: textWidth });
    const rowH = Math.max(textH, BODY_FONT_SIZE + 2);
    if (y + rowH > maxY) {
      doc.addPage({
        size: "A4",
        layout: "portrait",
        margins: { top: 0, left: 0, right: 0, bottom: 0 },
      });
      y = MARGIN;
    }
    doc
      .font(FONT_REGULAR)
      .fontSize(BODY_FONT_SIZE)
      .fillColor("#000")
      .text(`${i + 1}.`, MARGIN, y, {
        width: NOTES_NUM_WIDTH,
        height: rowH,
        lineBreak: false,
      });
    y = drawRuns(
      doc,
      runs,
      MARGIN + NOTES_NUM_WIDTH,
      y,
      textWidth,
      BODY_FONT_SIZE,
    );
    y += 4;
  }
  return y;
}

function logoPathOrSkip(doc: PDFKit.PDFDocument, y: number): number {
  const path = resolveBrandLogoPath();
  if (!path) return y;
  const height = 48;
  try {
    doc.image(path, MARGIN, y, { height });
    return y + height + 8;
  } catch {
    return y;
  }
}

export async function buildLotConfirmationPdf(
  input: LotConfirmationPdfInput,
): Promise<Buffer> {
  const cols = resolveLotConfirmationColumnWidths(input.taxLabel);
  const letterDate = input.letterDate ?? formatDate(new Date());
  const auctionDate = formatDate(input.auctionDate) || input.auctionDate;
  const client = input.clientName;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "portrait",
      margins: { top: 0, left: 0, right: 0, bottom: 0 },
      autoFirstPage: true,
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    registerTimesNewRoman(doc);

    let y = MARGIN;
    y = logoPathOrSkip(doc, y);

    doc
      .font(FONT_BOLD)
      .fontSize(16)
      .fillColor("#000")
      .text("Lot Confirmation Letter", MARGIN, y, {
        width: CONTENT_WIDTH,
        align: "center",
      });
    y = doc.y + 10;

    y = drawWrappedText(doc, input.bidderCompany, y, {
      bold: true,
      size: 11,
    });
    if (input.bidderAddress) {
      y = drawWrappedText(doc, input.bidderAddress, y + 2, { size: 9 });
    }
    if (input.bidderCityPin) {
      y = drawWrappedText(doc, input.bidderCityPin, y + 1, { size: 9 });
    }
    y = drawWrappedText(doc, `Email: ${input.bidderEmail}`, y + 1, {
      size: 9,
    });
    y = drawWrappedText(doc, `Number: ${input.bidderPhone}`, y + 1, {
      size: 9,
    });
    y = drawWrappedText(doc, `PAN: ${input.bidderPan}`, y + 1, { size: 9 });
    y = drawWrappedText(doc, `${input.taxLabel}: ${input.bidderGstin}`, y + 1, {
      size: 9,
    });
    y = drawWrappedText(
      doc,
      `Ref: Auction ID: ${input.auctionNumber} for ${client} Auction conducted on ${auctionDate}.`,
      y + 4,
      { size: 10, bold: true },
    );

    y = drawWrappedText(doc, "Dear Sir,", y + 12, { bold: true });
    y = drawRuns(
      doc,
      [
        {
          text: "This is with reference to your offer given for the following lot. Your bid has been accepted by ",
        },
        { text: client, bold: true },
        { text: " for the lots as mentioned below:" },
      ],
      MARGIN,
      y + 6,
      CONTENT_WIDTH,
      10,
    );
    y += 10;

    const headerCells = Object.fromEntries(
      cols.map((c) => [c.key, c.header]),
    ) as Record<CellKey, string>;
    const maxY = PAGE_HEIGHT - MARGIN - FOOTER_RESERVE;

    const ensureSpace = (needed: number) => {
      if (y + needed <= maxY) return;
      doc.addPage({
        size: "A4",
        layout: "portrait",
        margins: { top: 0, left: 0, right: 0, bottom: 0 },
      });
      y = MARGIN;
      y = drawRow(doc, cols, headerCells, y, {
        header: true,
        fill: HEADER_FILL,
        fontSize: HEADER_FONT_SIZE,
      });
    };

    y = drawRow(doc, cols, headerCells, y, {
      header: true,
      fill: HEADER_FILL,
      fontSize: HEADER_FONT_SIZE,
    });

    let grandTotal = 0;
    for (const lot of input.lots) {
      const cells = lineToCells(lot);
      const amounts = lotConfirmationLineAmounts({
        winningAmount: lot.winningAmount,
        quantity: lot.quantity,
        gstPercentage: lot.gstPercentage,
        tcsPercentage: lot.tcsPercentage,
      });
      grandTotal += amounts.lineTotal;
      const rowH = measureRowHeight(doc, cols, cells, FONT_SIZE, false);
      ensureSpace(rowH);
      y = drawRow(doc, cols, cells, y, { fontSize: FONT_SIZE });
    }

    const totalAmount = formatNumber(Math.round(grandTotal));
    ensureSpace(20);
    y = drawTotalRow(doc, cols, totalAmount, y);

    const notes: TextRun[][] = [
      [
        {
          text: "Please deploy the vehicle for lifting of material as per the requirement of company.",
        },
      ],
      [
        {
          text: "Please make the payment of security deposits / payments for the above mentioned lot/lots to ",
        },
        { text: client, bold: true },
        {
          text: " as per payment terms mentioned in our auction catalogue.",
        },
      ],
      [
        {
          text: "Please deposit payment before deployment of vehicle in plant.",
        },
      ],
      [
        {
          text: "All payments to be made through RTGS / NEFT / DD to the account of ",
        },
        { text: client, bold: true },
        { text: ". Cash / Cheque will not be accepted." },
      ],
      [
        {
          text: "All Buyers are required to intimate the concerned official one day advance to place vehicle for material lifting.",
        },
      ],
      [
        {
          text: "All other terms & conditions are as mentioned in our auction catalogue stands valid.",
        },
      ],
    ];

    const notesBlock = 28 + notes.length * 18 + 70;
    if (y + notesBlock > maxY) {
      doc.addPage({
        size: "A4",
        layout: "portrait",
        margins: { top: 0, left: 0, right: 0, bottom: 0 },
      });
      y = MARGIN;
    }

    y = drawWrappedText(doc, "Also note following:", y + 14, {
      bold: true,
    });
    y += 6;
    y = drawNotesTable(doc, notes, y, maxY);

    const payment = input.paymentContacts.filter(Boolean).join(", ");
    y += 12;
    const payLabel = "For Payment:";
    doc.font(FONT_BOLD).fontSize(10);
    const labelWidth = doc.widthOfString(payLabel) + 4;
    doc.rect(MARGIN, y - 1, labelWidth, 13).fill("#ffff00");
    doc.fillColor("#000").text(payLabel, MARGIN + 2, y, {
      width: labelWidth,
      lineBreak: false,
    });
    y = drawRuns(
      doc,
      [{ text: " Please contact " }, { text: payment || "—", bold: true }],
      MARGIN + labelWidth,
      y,
      CONTENT_WIDTH - labelWidth,
      10,
    );
    y += 12;

    y = drawWrappedText(doc, "Thanks & Regards,", y, {
      bold: true,
      size: 11,
    });
    y = drawWrappedText(doc, "Ajeet Kumar Singh", y + 4, { size: 10 });
    y = drawWrappedText(doc, "+919935889777", y + 1, { size: 10 });
    y = drawWrappedText(doc, "Email: Ajeet.Singh@auctionit.in", y + 1, {
      size: 10,
    });
    drawWrappedText(doc, `Dated : ${letterDate}`, y + 1, { size: 10 });

    doc.end();
  });
}

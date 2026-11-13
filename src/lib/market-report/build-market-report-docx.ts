import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
  type IBorderOptions,
} from "docx";
import { AdminReportsMessages } from "@auctionit/messages/reports";
import type {
  MarketReport,
  MarketReportLotRow,
} from "../../services/market-report.service.js";
import { readBrandLogo } from "../brand-logo.js";
import type { RichTextNode } from "./rich-text.js";
import { marketMakingNumbering, richTextToDocx } from "./rich-text-to-docx.js";
import {
  TREND_CHART_HEIGHT,
  TREND_CHART_WIDTH,
  renderTrendChartPng,
} from "./trend-chart-png.js";

export const MARKET_REPORT_CONDUCTED_BY = {
  name: "iCom Analytics Limited",
  address: "28 Najafgarh Road, New Delhi-110015",
  website: "www.auctionit.in",
  websiteUrl: "https://www.auctionit.in/",
} as const;
export const MARKET_REPORT_AUCTION_TYPE = "English No Ties";
export const MARKET_REPORT_AUTO_EXTENSION = "(Auto Extension as Applicable)";
export const MARKET_REPORT_VALIDITY =
  "Validity: For all details, please refer below";

export const MARKET_REPORT_PRICE_COLUMNS = [
  "Lot No.",
  "Material Description",
  "Qty. (MT)",
  "Previous Auction Date",
  "Benchmark Price as on Previous Auction Date",
  "Benchmark Price as of Today",
  "Previous SBP",
  "Previous Winning Price",
  "Suggested SBP",
] as const;

const FONT = "Times New Roman";
const BORDER_COLOR = "999999";
/** Letter page, in twips. */
const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
/** Word's "Narrow" preset: 0.5" on every side. */
const PAGE_MARGIN = 720;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
/** Font sizes are in half-points (24 = 12pt). */
const TITLE_SIZE = 36;
const SECTION_SIZE = 28;
const HEADER_TABLE_SIZE = 24;
const BODY_SIZE = 24;
const PRICE_HEADER_SIZE = 20;
const PRICE_BODY_SIZE = 20;
/** Relative price-table column widths, scaled to the content width. */
const PRICE_GRID = [1800, 1750, 750, 950, 1200, 1200, 1000, 1000, 1150];
/** Share of the header table given to the label column. */
const HEADER_LABEL_RATIO = 0.3;
const LOGO_WIDTH = 64;
const LOGO_HEIGHT = Math.round((LOGO_WIDTH * 284) / 400);
/** Logo width in twips (15 per pixel) plus a little breathing room. */
const LOGO_COLUMN_WIDTH = LOGO_WIDTH * 15 + 150;
/** Full content width in pixels (96 per inch; 15 twips per pixel). */
const CHART_DOC_WIDTH = CONTENT_WIDTH / 15;
const CHART_DOC_HEIGHT = Math.round(
  (CHART_DOC_WIDTH * TREND_CHART_HEIGHT) / TREND_CHART_WIDTH,
);
const MONTHS = [
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
];

const border: IBorderOptions = {
  style: BorderStyle.SINGLE,
  size: 6,
  color: BORDER_COLOR,
};
const cellBorders = { top: border, bottom: border, left: border, right: border };
const noBorder: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = {
  top: noBorder,
  bottom: noBorder,
  left: noBorder,
  right: noBorder,
};
const cellMargins = { top: 75, bottom: 75, left: 75, right: 75 };

/** `YYYY-MM-DD` → `dd MMM yyyy` */
export function formatReportDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const [year, month, day] = isoDate.slice(0, 10).split("-");
  return `${day} ${MONTHS[Number(month) - 1] ?? ""} ${year}`;
}

/** `HH:MM` → `hh:mm AM` */
export function formatReportTime(hhmm: string | null): string | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return null;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function auctionTimeLabel(report: MarketReport): string {
  const start = formatReportTime(report.header.startTime) ?? "NA";
  const end = formatReportTime(report.header.endTime) ?? "NA";
  return `${start} To ${end}`;
}

/** Null or 0 → "NA", matching the legacy report. */
export function formatReportAmount(
  value: number | null,
  maxDecimals = 2,
): string {
  if (value == null || value === 0) return "NA";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

export function marketReportTitle(report: MarketReport): string {
  return `Market Report (${report.header.auctionNumber ?? report.header.auctionId})`;
}

export function lotRowCells(row: MarketReportLotRow): string[] {
  return [
    row.lotNumber ?? "",
    row.description ?? "",
    formatReportAmount(row.quantity, 3),
    formatReportDate(row.previousAuctionDate) ?? "NA",
    formatReportAmount(row.previousBenchmarkPrice),
    formatReportAmount(row.currentBenchmarkPrice),
    formatReportAmount(row.previousSbp),
    formatReportAmount(row.previousWinningPrice),
    formatReportAmount(row.suggestedSbp),
  ];
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 120 },
    keepNext: true,
    children: [new TextRun({ text, bold: true, size: SECTION_SIZE })],
  });
}

function textCell(
  lines: (string | TextRun | ExternalHyperlink)[][],
  opts: { width: number; bold?: boolean; size: number },
): TableCell {
  return new TableCell({
    width: { size: opts.width, type: WidthType.DXA },
    borders: cellBorders,
    margins: cellMargins,
    verticalAlign: VerticalAlignTable.CENTER,
    children: lines.map(
      (parts) =>
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: parts.map((part) =>
            typeof part === "string"
              ? new TextRun({ text: part, bold: opts.bold, size: opts.size })
              : part,
          ),
        }),
    ),
  });
}

function headerTable(report: MarketReport): Table {
  const labelWidth = Math.round(CONTENT_WIDTH * HEADER_LABEL_RATIO);
  const valueWidth = CONTENT_WIDTH - labelWidth;
  const row = (
    label: string,
    lines: (string | TextRun | ExternalHyperlink)[][],
    boldValue = false,
  ) =>
    new TableRow({
      cantSplit: true,
      children: [
        textCell([[label]], {
          width: labelWidth,
          bold: true,
          size: HEADER_TABLE_SIZE,
        }),
        textCell(lines, {
          width: valueWidth,
          bold: boldValue,
          size: HEADER_TABLE_SIZE,
        }),
      ],
    });

  return new Table({
    alignment: AlignmentType.LEFT,
    layout: TableLayoutType.FIXED,
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [labelWidth, valueWidth],
    rows: [
      row("Seller Name", [[report.header.clientName]]),
      row("Auction Conducted By", [
        [MARKET_REPORT_CONDUCTED_BY.name],
        [MARKET_REPORT_CONDUCTED_BY.address],
        [
          new ExternalHyperlink({
            link: MARKET_REPORT_CONDUCTED_BY.websiteUrl,
            children: [
              new TextRun({
                text: MARKET_REPORT_CONDUCTED_BY.website,
                size: HEADER_TABLE_SIZE,
              }),
            ],
          }),
        ],
      ]),
      row(
        "Date and Time of Auction",
        [
          [`Auction Date: ${formatReportDate(report.header.auctionDate) ?? ""}`],
          [`Auction Time: ${auctionTimeLabel(report)}`],
          [MARKET_REPORT_AUTO_EXTENSION],
          [MARKET_REPORT_VALIDITY],
        ],
        true,
      ),
      row("Type of Auction", [[MARKET_REPORT_AUCTION_TYPE]]),
    ],
  });
}

function priceTable(report: MarketReport): Table {
  const gridTotal = PRICE_GRID.reduce((a, b) => a + b, 0);
  const widths = PRICE_GRID.map((w) => Math.floor((w * CONTENT_WIDTH) / gridTotal));
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: MARKET_REPORT_PRICE_COLUMNS.map((label, i) =>
      textCell([[label]], {
        width: widths[i]!,
        bold: true,
        size: PRICE_HEADER_SIZE,
      }),
    ),
  });
  const body = report.lots.map(
    (lot) =>
      new TableRow({
        cantSplit: true,
        children: lotRowCells(lot).map((value, i) =>
          textCell([[value]], { width: widths[i]!, size: PRICE_BODY_SIZE }),
        ),
      }),
  );
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: [header, ...body],
  });
}

/** Logo and title on one line, in a borderless two-column table. */
function titleBlock(report: MarketReport): Table {
  const logo = readBrandLogo();
  const titleWidth = CONTENT_WIDTH - LOGO_COLUMN_WIDTH;
  const cell = (width: number, children: Paragraph[]) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      borders: noBorders,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      verticalAlign: VerticalAlignTable.CENTER,
      children,
    });

  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [LOGO_COLUMN_WIDTH, titleWidth],
    borders: {
      top: noBorder,
      bottom: noBorder,
      left: noBorder,
      right: noBorder,
      insideHorizontal: noBorder,
      insideVertical: noBorder,
    },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          cell(LOGO_COLUMN_WIDTH, [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: logo
                ? [
                    new ImageRun({
                      type: "jpg",
                      data: logo,
                      transformation: { width: LOGO_WIDTH, height: LOGO_HEIGHT },
                    }),
                  ]
                : [],
            }),
          ]),
          cell(titleWidth, [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [
                new TextRun({
                  text: marketReportTitle(report),
                  bold: true,
                  size: TITLE_SIZE,
                }),
              ],
            }),
          ]),
        ],
      }),
    ],
  });
}

export async function buildMarketReportDocx(
  report: MarketReport,
  marketMaking: RichTextNode | null | undefined,
): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    titleBlock(report),
    new Paragraph({ spacing: { after: 120 }, children: [] }),
    headerTable(report),
    sectionHeading("Market Making:"),
    ...richTextToDocx(marketMaking, { fontSize: BODY_SIZE }),
    sectionHeading("Price Trend:"),
  ];

  if (report.rows.length > 0 && report.series.length > 0) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [
          new ImageRun({
            type: "png",
            data: renderTrendChartPng(report.series, report.rows),
            transformation: { width: CHART_DOC_WIDTH, height: CHART_DOC_HEIGHT },
          }),
        ],
      }),
    );
  } else {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: AdminReportsMessages.MARKET_TREND_EMPTY,
            size: BODY_SIZE,
          }),
        ],
      }),
    );
  }

  children.push(
    sectionHeading("Previous auction price and suggested start bid price (SBP):"),
    priceTable(report),
  );

  const doc = new Document({
    creator: MARKET_REPORT_CONDUCTED_BY.name,
    title: marketReportTitle(report),
    styles: { default: { document: { run: { font: FONT } } } },
    numbering: marketMakingNumbering(),
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: {
              top: PAGE_MARGIN,
              right: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
            },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/[^\x20-\x7E]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** e.g. `Market Report of Surya Roshni Limited SRL-e-Sales-2026-27-FA-05 Dated - 17.04.2026.docx` */
export function buildMarketReportFilename(report: MarketReport): string {
  const [year, month, day] = report.header.auctionDate.slice(0, 10).split("-");
  const client = sanitizeFilenamePart(report.header.clientName);
  const auction = sanitizeFilenamePart(
    report.header.auctionNumber ?? String(report.header.auctionId),
  );
  return `Market Report of ${client} ${auction} Dated - ${day}.${month}.${year}.docx`;
}

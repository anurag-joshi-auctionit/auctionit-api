import { formatDate } from "@auctionit/lib/date";
import {
  buildRowsXlsx,
  columnRangeFrom,
  type ExportColumn,
  ignoreNumberStoredAsText,
  writeGeneratedAtRow,
} from "@auctionit/xlsx-export";
import ExcelJS from "exceljs";
import { reportGeneratedAt } from "../reports/report-title.js";
import type {
  AdminBidDetailsReportRow,
  AuctionDetailsReport,
  AuctionOverviewReportRow,
  BidOverviewReportRow,
  BidderOverviewReportRow,
  BidderDetailsReportRow,
} from "../../services/admin-reports.service.js";
import type {
  BenchmarkReport,
  BenchmarkReportRow,
} from "../../services/benchmark-report.service.js";
import type { SealedBidReportRow } from "../../services/sealed-bid-report.service.js";
import type { SubscriptionReportRow } from "../../services/subscription-report.service.js";

function str(v: string | number | null | undefined): string {
  if (v == null) return "";
  return String(v);
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? iso;
}

function dateTimeLabel(iso: string | null): string {
  if (!iso) return "";
  return iso.replace("T", " ");
}

const BID_OVERVIEW_COLUMNS: ExportColumn<BidOverviewReportRow>[] = [
  { header: "Auction No.", width: 16, asText: true, value: (r) => str(r.auctionNumber) },
  { header: "Auction Date", width: 14, value: (r) => str(r.auctionDate) },
  { header: "Lot No.", width: 14, asText: true, value: (r) => str(r.lotNumber) },
  {
    header: "Plant Location",
    width: 22,
    value: (r) => str(r.plantLocationName),
  },
  { header: "Quantity", width: 12, value: (r) => r.quantity },
  { header: "Unit", width: 10, value: (r) => str(r.unit) },
  { header: "Start Bid Price", width: 14, value: (r) => r.startBidPrice },
  { header: "Start Time", width: 12, value: (r) => timeLabel(r.startTime) },
  { header: "End Time", width: 12, value: (r) => timeLabel(r.endTime) },
  { header: "Winning Bidder", width: 28, value: (r) => str(r.winningBidder) },
  { header: "Winning Price", width: 14, value: (r) => r.winningPrice },
  { header: "No. of Bids", width: 12, value: (r) => r.bidCount },
  { header: "No. of Bidders", width: 14, value: (r) => r.bidderCount },
];

const BID_DETAILS_COLUMNS: ExportColumn<AdminBidDetailsReportRow>[] = [
  { header: "Auction No.", width: 16, asText: true, value: (r) => str(r.auctionNumber) },
  { header: "Auction Date", width: 14, value: (r) => str(r.auctionDate) },
  { header: "Lot No.", width: 14, asText: true, value: (r) => str(r.lotNumber) },
  { header: "Start Bid Price", width: 14, value: (r) => r.startBidPrice },
  { header: "Start Time", width: 12, value: (r) => timeLabel(r.startTime) },
  { header: "End Time", width: 12, value: (r) => timeLabel(r.endTime) },
  { header: "Bidder Name", width: 28, value: (r) => str(r.bidderName) },
  { header: "Username", width: 18, asText: true, value: (r) => str(r.username) },
  { header: "Bid Time", width: 28, value: (r) => dateTimeLabel(r.bidTime) },
  { header: "Unit", width: 14, value: (r) => str(r.bidBasis) },
  { header: "Bid Price", width: 16, value: (r) => r.bidPrice },
  { header: "Bid Type", width: 12, value: (r) => str(r.bidType) },
  { header: "Quantity", width: 12, value: (r) => r.quantity },
];

const SEALED_BID_COLUMNS: ExportColumn<SealedBidReportRow>[] = [
  { header: "Client Name", width: 28, value: (r) => str(r.clientName) },
  { header: "Client ID", width: 10, value: (r) => r.clientId },
  { header: "Auction No.", width: 16, asText: true, value: (r) => str(r.auctionNumber) },
  { header: "Auction Date", width: 14, value: (r) => str(r.auctionDate) },
  { header: "Lot No.", width: 14, asText: true, value: (r) => str(r.lotNumber) },
  { header: "UOM", width: 10, value: (r) => str(r.uom) },
  { header: "Sealed-bid Date", width: 14, value: (r) => str(r.sealedBidDate) },
  { header: "Start Time", width: 12, value: (r) => timeLabel(r.startTime) },
  { header: "End Time", width: 12, value: (r) => timeLabel(r.endTime) },
  { header: "Min Desired Price", width: 16, value: (r) => r.minAmount },
  { header: "Max Desired Price", width: 16, value: (r) => r.maxAmount },
  { header: "Avg. Desired Price", width: 16, value: (r) => r.avgAmount },
  { header: "Winning Bidder", width: 28, value: (r) => str(r.winningBidder) },
  { header: "Winning Amount", width: 16, value: (r) => r.winningAmount },
];

const BIDDER_DETAILS_COLUMNS: ExportColumn<BidderDetailsReportRow>[] = [
  { header: "Client Name", width: 28, value: (r) => str(r.clientName) },
  { header: "Auction No.", width: 16, asText: true, value: (r) => str(r.auctionNumber) },
  { header: "Auction Date", width: 14, value: (r) => str(r.auctionDate) },
  { header: "Bidder Name", width: 24, value: (r) => str(r.bidderName) },
  { header: "Username", width: 18, asText: true, value: (r) => str(r.username) },
  { header: "Bidder ID", width: 12, value: (r) => r.bidderId },
  { header: "Company Name", width: 28, value: (r) => str(r.companyName) },
  { header: "Phone", width: 16, asText: true, value: (r) => str(r.phone) },
  { header: "Email", width: 28, value: (r) => str(r.email) },
  {
    header: "Last Login At",
    width: 20,
    value: (r) => dateTimeLabel(r.lastLoginAt),
  },
  {
    header: "Last Logout At",
    width: 20,
    value: (r) => dateTimeLabel(r.lastLogoutAt),
  },
  {
    header: "Participated",
    width: 14,
    value: (r) => (r.placedBid ? "Yes" : "No"),
  },
  {
    header: "New",
    width: 10,
    value: (r) => (r.isNew ? "Yes" : "No"),
  },
  {
    header: "T&C Accepted At",
    width: 20,
    value: (r) => dateTimeLabel(r.tncAcceptedAt),
  },
];

const BIDDER_OVERVIEW_COLUMNS: ExportColumn<BidderOverviewReportRow>[] = [
  { header: "Client", width: 28, value: (r) => str(r.clientName) },
  { header: "Auction No.", width: 20, asText: true, value: (r) => str(r.auctionNumber) },
  { header: "Auction Date", width: 14, value: (r) => str(r.auctionDate) },
  { header: "Attached", width: 12, value: (r) => r.attached },
  { header: "Logged In", width: 12, value: (r) => r.loggedIn },
  { header: "Participated", width: 14, value: (r) => r.participated },
  { header: "Winners", width: 12, value: (r) => r.winners },
  { header: "New Attached", width: 14, value: (r) => r.newAttached },
  { header: "New Participated", width: 16, value: (r) => r.newParticipated },
  { header: "New Winners", width: 14, value: (r) => r.newWinners },
];

const AUCTION_OVERVIEW_COLUMNS: ExportColumn<AuctionOverviewReportRow>[] = [
  { header: "Client", width: 28, value: (r) => str(r.clientName) },
  { header: "Auction No.", width: 16, asText: true, value: (r) => str(r.auctionNumber) },
  { header: "Auction Date", width: 14, value: (r) => str(r.auctionDate) },
  { header: "Lot No.", width: 14, asText: true, value: (r) => str(r.lotNumber) },
  { header: "Start Time", width: 12, value: (r) => timeLabel(r.startTime) },
  { header: "End Time", width: 12, value: (r) => timeLabel(r.endTime) },
  { header: "Quantity", width: 12, value: (r) => r.quantity },
  { header: "UOM", width: 10, value: (r) => str(r.unit) },
  { header: "Start Bid Price", width: 14, value: (r) => r.startBidPrice },
  { header: "Bid Increment", width: 14, value: (r) => r.bidIncrement },
  { header: "Winning Price", width: 14, value: (r) => r.winningPrice },
  { header: "Winning Bidder", width: 28, value: (r) => str(r.winningBidder) },
  { header: "No. of Bids", width: 12, value: (r) => r.bidCount },
  { header: "No. of Bidders", width: 14, value: (r) => r.bidderCount },
];

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export async function buildBidOverviewReportXlsx(
  rows: BidOverviewReportRow[],
  title: string,
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Bid Overview Report",
    title,
    generatedAt: reportGeneratedAt(),
    columns: BID_OVERVIEW_COLUMNS,
    rows,
  });
}

export function buildBidOverviewReportFilename(): string {
  return `bid-overview-report-${stamp()}.xlsx`;
}

export async function buildAdminBidDetailsReportXlsx(
  rows: AdminBidDetailsReportRow[],
  title: string,
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Bid Details Report",
    title,
    generatedAt: reportGeneratedAt(),
    columns: BID_DETAILS_COLUMNS,
    rows,
  });
}

export function buildAdminBidDetailsReportFilename(): string {
  return `bid-details-report-${stamp()}.xlsx`;
}

export async function buildSealedBidReportXlsx(
  rows: SealedBidReportRow[],
  title: string,
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Sealed-Bid Report",
    title,
    generatedAt: reportGeneratedAt(),
    columns: SEALED_BID_COLUMNS,
    rows,
  });
}

export function buildSealedBidReportFilename(): string {
  return `sealed-bid-report-${stamp()}.xlsx`;
}

export async function buildBidderDetailsReportXlsx(
  rows: BidderDetailsReportRow[],
  title: string,
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Bidder Details Report",
    title,
    generatedAt: reportGeneratedAt(),
    columns: BIDDER_DETAILS_COLUMNS,
    rows,
  });
}

export function buildBidderDetailsReportFilename(): string {
  return `bidder-details-report-${stamp()}.xlsx`;
}

export async function buildBidderOverviewReportXlsx(
  rows: BidderOverviewReportRow[],
  title: string,
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Bidder Overview Report",
    title,
    generatedAt: reportGeneratedAt(),
    columns: BIDDER_OVERVIEW_COLUMNS,
    rows,
  });
}

export function buildBidderOverviewReportFilename(): string {
  return `bidder-overview-report-${stamp()}.xlsx`;
}

export async function buildAuctionOverviewReportXlsx(
  rows: AuctionOverviewReportRow[],
  title: string,
): Promise<Buffer> {
  return buildRowsXlsx({
    sheetName: "Auction Overview Report",
    title,
    generatedAt: reportGeneratedAt(),
    columns: AUCTION_OVERVIEW_COLUMNS,
    rows,
  });
}

export function buildAuctionOverviewReportFilename(): string {
  return `auction-overview-report-${stamp()}.xlsx`;
}

export async function buildBenchmarkReportXlsx(
  report: BenchmarkReport,
  title: string,
): Promise<Buffer> {
  const columns: ExportColumn<BenchmarkReportRow>[] = [
    { header: "Date", width: 14, value: (r) => r.date },
    ...report.series.map(
      (s): ExportColumn<BenchmarkReportRow> => ({
        header: s.label,
        width: 16,
        value: (r) => r.prices[String(s.comboId)] ?? null,
      }),
    ),
  ];
  return buildRowsXlsx({
    sheetName: "Benchmark Report",
    title,
    generatedAt: reportGeneratedAt(),
    columns,
    rows: report.rows,
  });
}

export function buildBenchmarkReportFilename(): string {
  return `benchmark-report-${stamp()}.xlsx`;
}

function subscriptionPeriodLabel(r: SubscriptionReportRow): string {
  if (!r.fromDate && !r.toDate) return "";
  return `${formatDate(r.fromDate) || "—"} – ${formatDate(r.toDate) || "—"}`;
}

export async function buildSubscriptionReportXlsx(
  rows: SubscriptionReportRow[],
  title: string,
): Promise<Buffer> {
  const indexed = rows.map((row, i) => ({ row, sno: i + 1 }));
  const columns: ExportColumn<(typeof indexed)[number]>[] = [
    { header: "S.No.", width: 8, value: (r) => r.sno },
    { header: "Bidder Name", width: 32, value: (r) => str(r.row.bidderName) },
    { header: "Bidder ID", width: 12, value: (r) => r.row.bidderId },
    {
      header: "Bidder Address",
      width: 48,
      value: (r) => str(r.row.bidderAddress),
    },
    { header: "Email", width: 30, value: (r) => str(r.row.email) },
    { header: "Mobile", width: 16, asText: true, value: (r) => str(r.row.mobile) },
    {
      header: "Subscription Type",
      width: 20,
      value: (r) => str(r.row.subscriptionTypeName),
    },
    {
      header: "Payment Date",
      width: 14,
      value: (r) => formatDate(r.row.paymentDate),
    },
    {
      header: "Payment Mode",
      width: 14,
      value: (r) => str(r.row.paymentModeName),
    },
    {
      header: "Transaction Reference No.",
      width: 40,
      asText: true,
      value: (r) => str(r.row.transactionId),
    },
    { header: "Amount", width: 14, value: (r) => r.row.amount },
    {
      header: "Subscription Period",
      width: 28,
      value: (r) => subscriptionPeriodLabel(r.row),
    },
  ];
  return buildRowsXlsx({
    sheetName: "Subscription Report",
    title,
    generatedAt: reportGeneratedAt(),
    columns,
    rows: indexed,
  });
}

export function buildSubscriptionReportFilename(): string {
  return `subscription-report-${stamp()}.xlsx`;
}

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF9B266" },
};

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  bottom: { style: "thin" },
  left: { style: "thin" },
  right: { style: "thin" },
};

function applyThinBorders(sheet: ExcelJS.Worksheet) {
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = THIN_BORDER;
    });
  });
}

function formatQtyUom(quantity: number | null, unit: string | null): string {
  const q = str(quantity);
  const u = str(unit);
  if (!q && !u) return "";
  if (!q) return u;
  if (!u) return q;
  return `${q} ${u}`;
}

function bidDateTimeLabel(iso: string | null): string {
  if (!iso) return "";
  // YYYY-MM-DDTHH:MM:SS.ffffff Asia/Kolkata wall clock → dd-mm-yy hh:mm:ss.ffffff AM/PM
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?/.exec(iso);
  if (!m) return dateTimeLabel(iso);
  const yy = m[1]!.slice(2);
  const month = m[2]!;
  const day = m[3]!;
  let hour = Number(m[4]);
  const minute = m[5]!;
  const second = m[6]!;
  const micros = (m[7] ?? "").padEnd(6, "0").slice(0, 6);
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  const hh = String(hour).padStart(2, "0");
  return `${day}-${month}-${yy} ${hh}:${minute}:${second}.${micros} ${ampm}`;
}

const TITLE_FONT_SIZE = 18;
/** Approx. line height (pt) for an 18pt bold title row. */
const TITLE_LINE_HEIGHT = 24;

/**
 * Merged, bold, centred title on row 1 that wraps within `columnWidths`.
 * Excel does not auto-fit merged rows, so height is estimated from text length.
 */
function writeWrappedTitle(
  sheet: ExcelJS.Worksheet,
  text: string,
  columnWidths: readonly number[],
) {
  columnWidths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
  sheet.mergeCells(1, 1, 1, columnWidths.length);
  const cell = sheet.getCell(1, 1);
  cell.value = text;
  cell.font = { bold: true, size: TITLE_FONT_SIZE };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };

  // Column width units ≈ characters at 11pt; bold 18pt glyphs are ~1.8× wider.
  const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0);
  const charsPerLine = Math.max(1, Math.floor((totalWidth * 11) / (TITLE_FONT_SIZE * 1.1)));
  const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
  sheet.getRow(1).height = lines * TITLE_LINE_HEIGHT;
}

export async function buildAuctionDetailsReportXlsx(
  report: AuctionDetailsReport,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AuctionIT";
  workbook.created = new Date();

  const auctionLabel = str(report.meta.auctionNumber) || "—";
  const titleSuffix = `for ${auctionLabel}`;
  const generatedAt = reportGeneratedAt();

  // --- Sheet 1: Auction Result Summary ---
  const ws1 = workbook.addWorksheet("Auction Result Summary");
  const additionalFields = report.additionalFields ?? [];
  const summaryWidths = [
    18, 12, 12, 28, 18, 28, 12, 10, 14, 14, 14, 28, 12, 14,
    ...additionalFields.map(() => 22),
  ];
  const summaryCols = summaryWidths.length;
  writeWrappedTitle(ws1, `Auction Summary ${titleSuffix}`, summaryWidths);
  writeGeneratedAtRow(ws1, {
    rowNumber: 2,
    generatedAt,
    columnCount: summaryCols,
  });

  const summaryHeaders = [
    "Lot No.",
    "Start Time",
    "End Time",
    "Client",
    "Plant Location",
    "Product",
    "Quantity",
    "UOM",
    "Start Bid Price",
    "Bid Increment",
    "Winning Price",
    "Winning Bidder",
    "No. of Bids",
    "No. of Bidders",
    ...additionalFields.map((f) => f.label),
  ];
  const headerRow1 = ws1.getRow(3);
  summaryHeaders.forEach((h, i) => {
    const cell = headerRow1.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
  });

  report.summary.forEach((r, idx) => {
    const row = ws1.getRow(4 + idx);
    row.getCell(1).value = str(r.lotNumber);
    row.getCell(2).value = timeLabel(r.startTime);
    row.getCell(3).value = timeLabel(r.endTime);
    row.getCell(4).value = str(r.clientName);
    row.getCell(5).value = str(r.plantLocationName);
    row.getCell(6).value = str(r.product);
    row.getCell(7).value = r.quantity;
    row.getCell(8).value = str(r.unit);
    row.getCell(9).value = r.startBidPrice;
    row.getCell(10).value = r.bidIncrement;
    row.getCell(11).value = r.winningPrice;
    row.getCell(12).value = str(r.winningBidder);
    row.getCell(13).value = r.bidCount;
    row.getCell(14).value = r.bidderCount;
    additionalFields.forEach((f, i) => {
      const v = r.additionalValues?.[f.key] ?? "";
      row.getCell(15 + i).value =
        f.dataType === "number" && v !== "" ? Number(v) : v;
    });
  });

  const footerRowNum = 4 + report.summary.length + 1;
  ws1.mergeCells(footerRowNum, 1, footerRowNum, summaryCols);
  const footer = ws1.getCell(footerRowNum, 1);
  footer.value = "Taxes and Duties are Extra";
  footer.font = { bold: true, size: 18 };
  footer.alignment = { horizontal: "center" };
  footer.fill = HEADER_FILL;
  applyThinBorders(ws1);

  // --- Sheet 2: Auction Detailed Bidding ---
  const ws2 = workbook.addWorksheet("Auction Detailed Bidding");
  writeWrappedTitle(ws2, `Detailed Bidding Report ${titleSuffix}`, [28, 28, 14, 14]);
  writeGeneratedAtRow(ws2, { rowNumber: 2, generatedAt, columnCount: 4 });

  const bidsByLot = new Map<number, typeof report.bids>();
  for (const bid of report.bids) {
    const list = bidsByLot.get(bid.lotId) ?? [];
    list.push(bid);
    bidsByLot.set(bid.lotId, list);
  }

  let rowNum = 4;
  for (const lot of report.summary) {
    const lotBids = bidsByLot.get(lot.lotId) ?? [];

    for (let c = 1; c <= 4; c++) {
      const cell = ws2.getCell(rowNum, c);
      cell.fill = HEADER_FILL;
      cell.font = { bold: true };
    }
    ws2.getCell(rowNum, 1).value = "Auction Details for Lot Number :";
    ws2.getCell(rowNum, 2).value = str(lot.lotNumber);
    rowNum += 1;

    ws2.getCell(rowNum, 1).value = "Company";
    ws2.getCell(rowNum, 1).font = { bold: true };
    ws2.getCell(rowNum, 2).value = str(lot.clientName);
    rowNum += 1;

    ws2.getCell(rowNum, 1).value = "Product";
    ws2.getCell(rowNum, 1).font = { bold: true };
    ws2.getCell(rowNum, 2).value = str(lot.product);
    rowNum += 1;

    ws2.getCell(rowNum, 1).value = "Quantity";
    ws2.getCell(rowNum, 1).font = { bold: true };
    ws2.getCell(rowNum, 2).value = formatQtyUom(lot.quantity, lot.unit);
    rowNum += 1;

    const bidHeader = ws2.getRow(rowNum);
    ["Date and Time", "Bidder", "Bid Amount", "Bid Type"].forEach((h, i) => {
      const cell = bidHeader.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true };
    });
    rowNum += 1;

    for (const bid of lotBids) {
      const row = ws2.getRow(rowNum);
      row.getCell(1).value = bidDateTimeLabel(bid.bidTime);
      row.getCell(2).value = str(bid.bidderName);
      row.getCell(3).value = bid.bidAmount;
      row.getCell(4).value =
        bid.bidType === "Proxy" ? "Proxy Bid" : "Manual Bid";
      rowNum += 1;
    }

    rowNum += 1; // blank gap between lots
  }
  applyThinBorders(ws2);

  // --- Sheet 3: Participants ---
  const ws3 = workbook.addWorksheet("Participants");
  writeWrappedTitle(ws3, `Participants EMD ${titleSuffix}`, [10, 32, 18, 14]);
  writeGeneratedAtRow(ws3, { rowNumber: 2, generatedAt, columnCount: 4 });

  const pHeader = ws3.getRow(3);
  ["S. No.", "Bidder", "Location", "EMD"].forEach((h, i) => {
    const cell = pHeader.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
  });

  report.participants.forEach((p, idx) => {
    const row = ws3.getRow(4 + idx);
    row.getCell(1).value = idx + 1;
    row.getCell(2).value = str(p.companyName);
    row.getCell(3).value = str(p.city);
    row.getCell(4).value = p.emdBalance;
  });
  applyThinBorders(ws3);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return ignoreNumberStoredAsText(buffer, {
    [ws1.name]: [
      columnRangeFrom(1, 4),
      ...additionalFields.flatMap((f, i) =>
        f.dataType === "number" ? [] : [columnRangeFrom(15 + i, 4)],
      ),
    ],
    [ws2.name]: [columnRangeFrom(2, 4)],
  });
}

export function buildAuctionDetailsReportFilename(): string {
  return `auction-details-report-${stamp()}.xlsx`;
}

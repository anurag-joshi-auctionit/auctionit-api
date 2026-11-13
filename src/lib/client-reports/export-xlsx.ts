import { buildRowsXlsx, type ExportColumn } from "@auctionit/xlsx-export";
import type {
  BidDetailsReportRow,
  BidOverviewReportRow,
} from "../../services/client-reports.service.js";
import { reportGeneratedAt } from "../reports/report-title.js";

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
  { header: "Auction No.", width: 16, value: (r) => str(r.auctionNumber) },
  { header: "Auction Date", width: 14, value: (r) => str(r.auctionDate) },
  { header: "Lot No.", width: 14, value: (r) => str(r.lotNumber) },
  { header: "Plant Location", width: 22, value: (r) => str(r.plantLocationName) },
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

const BID_DETAILS_COLUMNS: ExportColumn<BidDetailsReportRow>[] = [
  { header: "Auction No.", width: 16, value: (r) => str(r.auctionNumber) },
  { header: "Auction Date", width: 14, value: (r) => str(r.auctionDate) },
  { header: "Lot No.", width: 14, value: (r) => str(r.lotNumber) },
  { header: "Start Bid Price", width: 14, value: (r) => r.startBidPrice },
  { header: "Start Time", width: 12, value: (r) => timeLabel(r.startTime) },
  { header: "End Time", width: 12, value: (r) => timeLabel(r.endTime) },
  { header: "Bidder Name", width: 28, value: (r) => str(r.bidderName) },
  { header: "Bid Time", width: 28, value: (r) => dateTimeLabel(r.bidTime) },
  { header: "Unit", width: 14, value: (r) => str(r.bidBasis) },
  { header: "Bid Price", width: 16, value: (r) => r.bidPrice },
  { header: "Bid Type", width: 12, value: (r) => str(r.bidType) },
  { header: "Quantity", width: 12, value: (r) => r.quantity },
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

export async function buildBidDetailsReportXlsx(
  rows: BidDetailsReportRow[],
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

export function buildBidDetailsReportFilename(): string {
  return `bid-details-report-${stamp()}.xlsx`;
}

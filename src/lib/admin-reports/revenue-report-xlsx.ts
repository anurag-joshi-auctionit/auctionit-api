import { dateRangeReportTitle } from "../reports/report-title.js";
import type { LiftingDetailRow } from "../../services/lifting-report.service.js";
import type {
  RevenueDetailRow,
  RevenueReportData,
  RevenueSummaryRow,
} from "../../services/revenue-report.service.js";
import {
  buildDateRangeReportFilename,
  buildReportWorkbook,
  reportSheet,
  type ReportColumn,
} from "./report-xlsx-writer.js";

export const REVENUE_SUMMARY_SHEET = "Revenue Summary";
export const REVENUE_DETAILS_SHEET = "Revenue Details";
export const LIFTING_DETAILS_SHEET = "Lifting Details";

const SUMMARY_COLUMNS: ReportColumn<RevenueSummaryRow>[] = [
  { header: "Client", width: 50, kind: "text", value: (r) => r.clientName },
  { header: "Auctioned Value (Period)", width: 20, kind: "money", value: (r) => r.auctionedValuePeriod },
  { header: "Approved Value (Period)", width: 20, kind: "money", value: (r) => r.approvedValuePeriod },
  { header: "Lifted Value (Period)", width: 20, kind: "money", value: (r) => r.liftedValuePeriod },
  { header: "Auctioned Value (ITD)", width: 20, kind: "money", value: (r) => r.auctionedValueItd },
  { header: "Approved Value (ITD)", width: 20, kind: "money", value: (r) => r.approvedValueItd },
  { header: "Lifted Value (ITD)", width: 20, kind: "money", value: (r) => r.liftedValueItd },
  { header: "Total Revenue", width: 18, kind: "money", value: (r) => r.totalRevenue },
];

const DETAILS_COLUMNS: ReportColumn<RevenueDetailRow>[] = [
  { header: "Client", width: 40, kind: "text", value: (r) => r.clientName },
  { header: "Auction No.", width: 36, kind: "text", value: (r) => r.auctionNumber },
  { header: "Auction Date", width: 13, kind: "date", value: (r) => r.auctionDate },
  { header: "Lot No.", width: 40, kind: "text", value: (r) => r.lotNumber },
  { header: "Plant Location", width: 20, kind: "text", value: (r) => r.plantLocation },
  { header: "Winning Bidder", width: 32, kind: "text", value: (r) => r.winningBidder },
  { header: "Winning Price", width: 15, kind: "money", value: (r) => r.winningPrice },
  { header: "Unit", width: 8, kind: "text", value: (r) => r.unit },
  { header: "Auctioned Qty.", width: 14, kind: "qty", value: (r) => r.auctionedQty },
  { header: "Approved Qty.", width: 14, kind: "qty", value: (r) => r.approvedQty },
  { header: "Lifted Qty.", width: 14, kind: "qty", value: (r) => r.liftedQty },
  { header: "Balance Qty.", width: 14, kind: "qty", value: (r) => r.balanceQty },
  { header: "Auctioned Value", width: 18, kind: "money", value: (r) => r.auctionedValue },
  { header: "Approved Value", width: 18, kind: "money", value: (r) => r.approvedValue },
  { header: "Lifted Value", width: 18, kind: "money", value: (r) => r.liftedValue },
  { header: "Lifting Status", width: 14, kind: "text", value: (r) => r.liftingStatus },
  { header: "Lifting Period", width: 13, kind: "int", value: (r) => r.liftingPeriod },
  { header: "Lifting Due Date", width: 15, kind: "date", value: (r) => r.liftingDueDate },
  { header: "Last Lifting Date", width: 15, kind: "date", value: (r) => r.lastLiftingDate },
  { header: "Lifting Delay (in days)", width: 15, kind: "int", value: (r) => r.liftingDelayDays },
  { header: "Benchmark Price", width: 16, kind: "money", value: (r) => r.benchmarkPrice },
  { header: "Benchmark Material", width: 22, kind: "text", value: (r) => r.benchmarkMaterial },
  { header: "Benchmark Location", width: 20, kind: "text", value: (r) => r.benchmarkLocation },
  { header: "Lot Review Status", width: 15, kind: "text", value: (r) => r.reviewStatus },
  { header: "Lot Reviewed At", width: 18, kind: "datetime", value: (r) => r.reviewedAt },
  { header: "Lot Reviewed By", width: 20, kind: "text", value: (r) => r.reviewedBy },
  { header: "Attached Bidders", width: 15, kind: "int", value: (r) => r.attachedBidders },
  { header: "Logged In Bidders", width: 16, kind: "int", value: (r) => r.loggedInBidders },
  { header: "Participated Bidders", width: 18, kind: "int", value: (r) => r.participatedBidders },
  { header: "Start Bid Price", width: 15, kind: "money", value: (r) => r.startBidPrice },
];

const LIFTING_COLUMNS: ReportColumn<LiftingDetailRow>[] = [
  { header: "Lifting Month", width: 13, kind: "month", value: (r) => r.liftingMonth },
  { header: "Client", width: 40, kind: "text", value: (r) => r.clientName },
  { header: "Auction No.", width: 36, kind: "text", value: (r) => r.auctionNumber },
  { header: "Auction Date", width: 13, kind: "date", value: (r) => r.auctionDate },
  { header: "Lot No.", width: 40, kind: "text", value: (r) => r.lotNumber },
  { header: "Winning Bidder", width: 32, kind: "text", value: (r) => r.winningBidder },
  { header: "Winning Price", width: 15, kind: "money", value: (r) => r.winningPrice },
  { header: "Unit", width: 8, kind: "text", value: (r) => r.unit },
  { header: "Approved Qty.", width: 14, kind: "qty", value: (r) => r.approvedQty },
  { header: "Lifted Qty. (Before Period)", width: 16, kind: "qty", value: (r) => r.liftedBeforePeriodQty },
  { header: "Lifted Qty. (Period)", width: 14, kind: "qty", value: (r) => r.liftedPeriodQty },
  { header: "Lifted Date", width: 13, kind: "date", value: (r) => r.liftedDate },
  { header: "Lifted Value", width: 18, kind: "money", value: (r) => r.liftedPeriodValue },
  { header: "Balance Qty.", width: 14, kind: "qty", value: (r) => r.balanceQty },
  { header: "Status", width: 14, kind: "text", value: (r) => r.status },
];

export type RevenueXlsxProgress =
  | { stage: "summary" }
  | { stage: "details"; written: number; total: number }
  | { stage: "lifting"; written: number; total: number }
  | { stage: "logo" };

export function buildRevenueReportXlsx(
  data: RevenueReportData,
  options: {
    from: string;
    to: string;
    generatedAt: string;
    onProgress?: (progress: RevenueXlsxProgress) => void;
  },
): Promise<Buffer> {
  const title = (sheet: string) =>
    dateRangeReportTitle(sheet, options.from, options.to);
  return buildReportWorkbook(
    [
      reportSheet({
        name: REVENUE_SUMMARY_SHEET,
        title: title(REVENUE_SUMMARY_SHEET),
        columns: SUMMARY_COLUMNS,
        rows: data.summary,
        onStart: () => options.onProgress?.({ stage: "summary" }),
      }),
      reportSheet({
        name: REVENUE_DETAILS_SHEET,
        title: title(REVENUE_DETAILS_SHEET),
        columns: DETAILS_COLUMNS,
        rows: data.details,
        freezeColumns: 1,
        onRows: (written, total) =>
          options.onProgress?.({ stage: "details", written, total }),
      }),
      reportSheet({
        name: LIFTING_DETAILS_SHEET,
        title: title(LIFTING_DETAILS_SHEET),
        columns: LIFTING_COLUMNS,
        rows: data.lifting,
        freezeColumns: 2,
        onRows: (written, total) =>
          options.onProgress?.({ stage: "lifting", written, total }),
      }),
    ],
    {
      generatedAt: options.generatedAt,
      onLogo: () => options.onProgress?.({ stage: "logo" }),
    },
  );
}

/** e.g. `RevenueReport_01Apr2024_to_28Sep2026.xlsx`. */
export function buildRevenueReportFilename(from: string, to: string): string {
  return buildDateRangeReportFilename("RevenueReport", from, to);
}

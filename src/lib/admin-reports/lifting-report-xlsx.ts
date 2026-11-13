import { dateRangeReportTitle } from "../reports/report-title.js";
import type {
  LiftingDetailRow,
  LiftingOverviewRow,
  LiftingReportData,
} from "../../services/lifting-report.service.js";
import {
  buildDateRangeReportFilename,
  buildReportWorkbook,
  reportSheet,
  type ReportColumn,
} from "./report-xlsx-writer.js";

export const LIFTING_OVERVIEW_SHEET = "Lifting Overview";
export const LIFTING_DETAIL_SHEET = "Lifting Detail";

const OVERVIEW_COLUMNS: ReportColumn<LiftingOverviewRow>[] = [
  { header: "Client", width: 40, kind: "text", value: (r) => r.clientName },
  { header: "Auction No.", width: 36, kind: "text", value: (r) => r.auctionNumber },
  { header: "Auction Date", width: 13, kind: "date", value: (r) => r.auctionDate },
  { header: "Lot No.", width: 40, kind: "text", value: (r) => r.lotNumber },
  { header: "Winning Bidder", width: 32, kind: "text", value: (r) => r.winningBidder },
  { header: "Winning Price", width: 15, kind: "money", value: (r) => r.winningPrice },
  { header: "Unit", width: 8, kind: "text", value: (r) => r.unit },
  { header: "Approved Qty.", width: 14, kind: "qty", value: (r) => r.approvedQty },
  { header: "Lifted Qty. (Before Period)", width: 16, kind: "qty", value: (r) => r.liftedBeforePeriodQty },
  { header: "Lifted Value (Before Period)", width: 18, kind: "money", value: (r) => r.liftedBeforePeriodValue },
  { header: "Lifted Qty. (Period)", width: 14, kind: "qty", value: (r) => r.liftedPeriodQty },
  { header: "Lifted Value (Period)", width: 18, kind: "money", value: (r) => r.liftedPeriodValue },
  { header: "Balance Qty.", width: 14, kind: "qty", value: (r) => r.balanceQty },
  { header: "Last Lifted Date", width: 15, kind: "date", value: (r) => r.lastLiftedDate },
  { header: "Status", width: 14, kind: "text", value: (r) => r.status },
];

const DETAIL_COLUMNS: ReportColumn<LiftingDetailRow>[] = [
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
  { header: "Lifted Value (Before Period)", width: 18, kind: "money", value: (r) => r.liftedBeforePeriodValue },
  { header: "Lifted Qty. (Period)", width: 14, kind: "qty", value: (r) => r.liftedPeriodQty },
  { header: "Lifted Value (Period)", width: 18, kind: "money", value: (r) => r.liftedPeriodValue },
  { header: "Lifted Date", width: 13, kind: "date", value: (r) => r.liftedDate },
  { header: "Balance Qty.", width: 14, kind: "qty", value: (r) => r.balanceQty },
  { header: "Status", width: 14, kind: "text", value: (r) => r.status },
];

export type LiftingXlsxProgress =
  | { stage: "overview"; written: number; total: number }
  | { stage: "detail"; written: number; total: number }
  | { stage: "logo" };

export function buildLiftingReportXlsx(
  data: LiftingReportData,
  options: {
    from: string;
    to: string;
    generatedAt: string;
    onProgress?: (progress: LiftingXlsxProgress) => void;
  },
): Promise<Buffer> {
  const title = (sheet: string) =>
    dateRangeReportTitle(sheet, options.from, options.to);
  return buildReportWorkbook(
    [
      reportSheet({
        name: LIFTING_OVERVIEW_SHEET,
        title: title(LIFTING_OVERVIEW_SHEET),
        columns: OVERVIEW_COLUMNS,
        rows: data.overview,
        freezeColumns: 1,
        onRows: (written, total) =>
          options.onProgress?.({ stage: "overview", written, total }),
      }),
      reportSheet({
        name: LIFTING_DETAIL_SHEET,
        title: title(LIFTING_DETAIL_SHEET),
        columns: DETAIL_COLUMNS,
        rows: data.detail,
        freezeColumns: 2,
        onRows: (written, total) =>
          options.onProgress?.({ stage: "detail", written, total }),
      }),
    ],
    {
      generatedAt: options.generatedAt,
      onLogo: () => options.onProgress?.({ stage: "logo" }),
    },
  );
}

/** e.g. `LiftingReport_01Apr2026_to_30Sep2026.xlsx`. */
export function buildLiftingReportFilename(from: string, to: string): string {
  return buildDateRangeReportFilename("LiftingReport", from, to);
}

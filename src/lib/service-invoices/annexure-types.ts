import type { WinnerRankLabel } from "@auctionit/lib/winner-rank";

export type ServiceInvoiceAnnexureLine = {
  lineOrder: number;
  auctionNumber: string;
  auctionDate: string;
  lotNumber: string;
  product: string;
  approvedQty: number;
  uom: string;
  /** Always Winning after parse/build; legacy empty string allowed for blank rows. */
  rankLabel: WinnerRankLabel | "";
  winningPrice: number;
  bidderName: string;
  liftedQty: number;
  amount: number;
};

export type ServiceInvoiceAnnexureTotals = {
  totalQuantity: number;
  totalAmount: number;
};

export type ServiceInvoiceAnnexureResult = {
  lines: ServiceInvoiceAnnexureLine[];
  totals: ServiceInvoiceAnnexureTotals;
};

export type ServiceInvoiceAnnexureParseIssue = {
  row: number;
  field?: string;
  message: string;
};

export type ServiceInvoiceAnnexureParseResult = {
  imported: number;
  failed: number;
  skipped: number;
  issues: ServiceInvoiceAnnexureParseIssue[];
  lines?: ServiceInvoiceAnnexureLine[];
  totals?: ServiceInvoiceAnnexureTotals;
};

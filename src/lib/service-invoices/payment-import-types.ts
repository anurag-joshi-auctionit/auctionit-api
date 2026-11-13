import type { ImportRowIssue } from "@auctionit/xlsx-import/types";

export type ServiceInvoicePaymentImportProgress = {
  phase: "parse" | "import";
  processed: number;
  total: number;
  percent: number;
  label: string;
};

export type ServiceInvoicePaymentImportResult = {
  total: number;
  imported: number;
  failed: number;
  skipped: number;
  message: string;
  issues: ImportRowIssue[];
  issuesTruncated: boolean;
};

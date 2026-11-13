import type { ImportRowIssue } from "@auctionit/xlsx-import/types";

export type SubscriptionInvoiceImportProgress = {
  phase: "parse" | "import";
  processed: number;
  total: number;
  percent: number;
  label: string;
};

export type SubscriptionInvoiceImportResult = {
  total: number;
  imported: number;
  failed: number;
  skipped: number;
  message: string;
  issues: ImportRowIssue[];
  issuesTruncated: boolean;
};

export type SubscriptionInvoiceImportPdfFile = {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
};

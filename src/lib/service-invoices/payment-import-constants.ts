import type { ImportHeaderDef } from "@auctionit/xlsx-import/types";

/** Max import rows per file. */
export const SI_PAYMENT_IMPORT_MAX_ROWS = 5_000;

/** Max upload file size (bytes). */
export const SI_PAYMENT_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Max per-row issues returned in the API response. */
export const SI_PAYMENT_IMPORT_MAX_ISSUES_IN_RESPONSE = 2_000;

export const SI_PAYMENT_IMPORT_SHEET = "Payments";

export const SI_PAYMENT_IMPORT_ROW_HEADER_KEYS = [
  "invoiceId",
  "invoiceNo",
  "paidAmount",
  "paidAt",
] as const;

export type SiPaymentImportHeaderKey =
  (typeof SI_PAYMENT_IMPORT_ROW_HEADER_KEYS)[number];

export const SI_PAYMENT_IMPORT_TEMPLATE_HEADERS: ReadonlyArray<
  ImportHeaderDef<SiPaymentImportHeaderKey>
> = [
  { key: "invoiceId", label: "Invoice ID", width: 14 },
  { key: "invoiceNo", label: "Invoice No.", width: 20 },
  { key: "paidAmount", label: "Paid Amount", width: 14 },
  { key: "paidAt", label: "Paid At", width: 14 },
];

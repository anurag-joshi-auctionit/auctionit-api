import type { ImportHeaderDef } from "@auctionit/xlsx-import/types";

/** Max import rows per file. */
export const SUB_INVOICE_IMPORT_MAX_ROWS = 5_000;

/** Max XLSX upload size (bytes). */
export const SUB_INVOICE_IMPORT_MAX_XLSX_BYTES = 10 * 1024 * 1024;

/** Max per-PDF size (bytes) — same as single invoice upload. */
export const SUB_INVOICE_IMPORT_MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Max PDF files in one import. */
export const SUB_INVOICE_IMPORT_MAX_PDFS = 5_000;

/** Max per-row issues returned in the API response. */
export const SUB_INVOICE_IMPORT_MAX_ISSUES_IN_RESPONSE = 2_000;

export const SUB_INVOICE_IMPORT_SHEET = "Invoices";

export const SUB_INVOICE_IMPORT_ROW_HEADER_KEYS = [
  "invoiceId",
  "bidderId",
  "invoiceNo",
  "invoicePdfFilename",
] as const;

export type SubInvoiceImportHeaderKey =
  (typeof SUB_INVOICE_IMPORT_ROW_HEADER_KEYS)[number];

export const SUB_INVOICE_IMPORT_TEMPLATE_HEADERS: ReadonlyArray<
  ImportHeaderDef<SubInvoiceImportHeaderKey>
> = [
  { key: "invoiceId", label: "Invoice Id", width: 14 },
  {
    key: "bidderId",
    label: "Bidder",
    width: 14,
    aliases: ["Bidder Id", "Bidder ID"],
  },
  {
    key: "invoiceNo",
    label: "Invoice no",
    width: 20,
    aliases: ["Invoice No.", "Invoice No", "Invoice Number"],
  },
  { key: "invoicePdfFilename", label: "Invoice PDF", width: 28 },
];

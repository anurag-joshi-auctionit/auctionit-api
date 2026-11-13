import { z } from "zod";
import {
  accountsServiceInvoiceActionSchema,
  annexureAutoQuerySchema,
  createServiceInvoiceSchema,
  patchServiceInvoiceSchema,
  serviceInvoicePaymentLogBodySchema,
  serviceInvoiceStatsQuerySchema,
  serviceInvoicesExportQuerySchema,
  serviceInvoicesListQuerySchema,
} from "../../lib/service-invoices/schemas.js";
import { BinaryFile, ErrorBody, IdParam, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  ServiceInvoice,
  ServiceInvoiceAnnexure,
  ServiceInvoiceAnnexureParseResult,
  ServiceInvoiceBulkEmailResult,
  ServiceInvoiceEmailQueued,
  ServiceInvoiceList,
  ServiceInvoiceOutstandingStats,
  ServiceInvoicePaymentImportResult,
  ServiceInvoicePaymentLogList,
  ServiceInvoicePaymentLogResult,
  ServiceInvoiceSignedUrl,
  ServiceInvoiceStats,
} from "../responses/service-invoices.js";

// Docs for src/routes/service-invoices.ts — see docs/api/README.md.
const r = documentRouter("/service-invoices");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// In-handler permission checks (on top of the router gate) answer 403 with `{ error }`.
const needsAccountsEdit = {
  description: "Requires the `service-invoices.accounts-edit` permission (checked in the handler).",
  schema: ErrorBody,
};
const needsAdminEdit = {
  description: "Requires the `service-invoices.admin-edit` permission (checked in the handler).",
  schema: ErrorBody,
};
const notFound = { description: "Service invoice not found.", schema: ErrorBody };

// Recreated from the inline schema in src/routes/service-invoices.ts.
const bulkSendEmailSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
});

const xlsxUploadBody = z.object({ file: BinaryFile.openapi({ description: "Excel file (.xlsx), max 10 MB." }) });
const pdfUploadBody = z.object({ file: BinaryFile.openapi({ description: "PDF file, max 10 MB." }) });

r.get("/", {
  summary: "List service invoices",
  description:
    "Paginated, filterable list. `dateField` picks which date `dateFrom`/`dateTo` filter on (`period` = billing period). " +
    "`excludeDraft=true` hides drafts (accounts view); `outstanding=true` keeps generated invoices with an unpaid balance.",
  query: serviceInvoicesListQuerySchema,
  responses: { 200: ServiceInvoiceList },
});

r.get("/stats", {
  summary: "Service invoice counts by status",
  query: serviceInvoiceStatsQuerySchema,
  responses: { 200: ServiceInvoiceStats },
});

r.get("/outstanding-stats", {
  summary: "Outstanding (unpaid) totals",
  description: "Count and unpaid amount of generated invoices that still have a balance, optionally for one client.",
  query: serviceInvoiceStatsQuerySchema,
  responses: { 200: ServiceInvoiceOutstandingStats },
});

r.get("/export", {
  summary: "Export service invoices (xlsx)",
  description:
    "Same filters as the list. `ids` (comma-separated) exports exactly those rows and ignores the filters. Capped at 5000 rows.",
  query: serviceInvoicesExportQuerySchema,
  responses: { 200: { description: "Excel workbook.", schema: BinaryFile, contentType: XLSX } },
});

r.post("/bulk-send-email", {
  summary: "Email invoices in bulk",
  description:
    "Queues one email per `generated` invoice to the client's billing email with the invoice PDF (and annexure PDF where the " +
    "fee type needs one) attached. PDFs must already exist; nothing is generated. `emailSentAt` is stamped by the worker " +
    "after delivery. Per-id outcomes are in `results`.",
  body: bulkSendEmailSchema,
  responses: {
    202: { description: "Emails queued.", schema: ServiceInvoiceBulkEmailResult },
    403: needsAccountsEdit,
  },
});

r.post("/:id/send-email", {
  summary: "Email one invoice",
  description: "Same as bulk send for a single invoice.",
  params: IdParam,
  responses: {
    202: { description: "Email queued.", schema: ServiceInvoiceEmailQueued },
    400: {
      description: "Invalid id, invoice not `generated`, no billing email, a PDF missing, or queueing failed.",
      schema: ErrorBody,
    },
    403: needsAccountsEdit,
    404: notFound,
  },
});

r.get("/payment-logs/import/template", {
  summary: "Payment import template (xlsx)",
  description: "Blank workbook with the columns Invoice ID, Invoice No., Paid Amount, Paid At.",
  responses: {
    200: { description: "Excel template.", schema: BinaryFile, contentType: XLSX },
    403: needsAccountsEdit,
  },
});

r.post("/payment-logs/import", {
  summary: "Bulk import payments",
  description:
    "Adds a payment log per row to `generated` invoices (matched by id and invoice number), capped at each invoice's grand " +
    "total. Row problems come back in `issues` (max 2000) rather than as an HTTP error. Max 5000 rows.",
  body: xlsxUploadBody,
  responses: {
    200: ServiceInvoicePaymentImportResult,
    400: { description: "File missing, not xlsx, or over 10 MB.", schema: ErrorBody },
    403: needsAccountsEdit,
  },
});

r.get("/annexure/auto", {
  summary: "Preview auto annexure",
  description:
    "Builds annexure lines from lifting logs of the client's plant whose lifting date falls in the period (one line per lot), " +
    "with totals. Used to fill an `auto` invoice form.",
  query: annexureAutoQuerySchema,
  responses: {
    200: ServiceInvoiceAnnexure,
    400: { description: "Invalid query, or `toDate` before `fromDate`.", schema: ValidationErrorBody },
  },
});

r.get("/annexure/template", {
  summary: "Manual annexure template (xlsx)",
  responses: { 200: { description: "Excel template.", schema: BinaryFile, contentType: XLSX } },
});

const annexureParseDoc = {
  description:
    "Parses and validates a manual annexure workbook and returns its lines and totals. Nothing is stored; send the file " +
    "as `annexureFileBase64` on create/update to persist it.",
  body: xlsxUploadBody,
  responses: {
    200: ServiceInvoiceAnnexureParseResult,
    400: { description: "File missing or not xlsx.", schema: ErrorBody },
    403: needsAdminEdit,
  },
};

r.post("/annexure/parse", { summary: "Parse manual annexure", ...annexureParseDoc });

r.post("/annexure/upload", {
  summary: "Parse manual annexure (deprecated alias)",
  ...annexureParseDoc,
  description: "Deprecated alias of `POST /service-invoices/annexure/parse`. " + annexureParseDoc.description,
  deprecated: true,
});

r.get("/:id/annexure/download", {
  summary: "Annexure xlsx download URL",
  params: IdParam,
  responses: {
    200: ServiceInvoiceSignedUrl,
    400: { description: "Invalid id, invoice cancelled, or no annexure stored.", schema: ErrorBody },
    404: notFound,
  },
});

r.get("/:id/annexure/pdf", {
  summary: "Annexure PDF download URL",
  description:
    "Rebuilds the annexure PDF from the stored xlsx and the invoice's current fee fields, stores it (replacing the previous one) " +
    "and returns a signed download URL.",
  params: IdParam,
  responses: {
    200: ServiceInvoiceSignedUrl,
    400: { description: "Invalid id, invoice cancelled, no annexure stored, or the annexure is empty.", schema: ErrorBody },
    404: notFound,
  },
});

r.get("/:id/annexure", {
  summary: "Annexure preview",
  description: "Lines and totals parsed from the stored annexure xlsx.",
  params: IdParam,
  responses: {
    200: ServiceInvoiceAnnexure,
    400: { description: "Invalid id, no annexure stored, or the annexure is empty.", schema: ErrorBody },
    404: notFound,
  },
});

r.post("/:id/files/annexure-pdf", {
  summary: "Upload annexure PDF",
  description: "Accounts uploads or replaces the annexure PDF while the invoice is `requested` or `generated`.",
  params: IdParam,
  body: pdfUploadBody,
  responses: {
    200: ServiceInvoice,
    400: { description: "Invalid id, missing/invalid PDF, or uploads not allowed in this status.", schema: ErrorBody },
    403: needsAccountsEdit,
    404: notFound,
  },
});

r.post("/:id/files/invoice-pdf", {
  summary: "Upload invoice PDF",
  description: "Accounts uploads or replaces the invoice PDF while the invoice is `requested` or `generated`.",
  params: IdParam,
  body: pdfUploadBody,
  responses: {
    200: ServiceInvoice,
    400: { description: "Invalid id, missing/invalid PDF, or uploads not allowed in this status.", schema: ErrorBody },
    403: needsAccountsEdit,
    404: notFound,
  },
});

r.patch("/:id/accounts", {
  summary: "Accounts invoice action",
  description:
    "Accounts sets invoice number, invoice date and payment due date (all three together, only while `requested`) and/or " +
    "changes status: `requested` → `generated` (needs the invoice PDF, the annexure PDF where the fee type needs one, and the " +
    "invoice details) or `recheck`; `generated` → `cancelled`. Invoice numbers are unique.",
  params: IdParam,
  body: accountsServiceInvoiceActionSchema,
  responses: {
    200: ServiceInvoice,
    400: {
      description: "Invalid input, transition not allowed, missing PDFs/details, or duplicate invoice number.",
      schema: ValidationErrorBody,
    },
    403: needsAccountsEdit,
    404: notFound,
  },
});

r.get("/:id/payment-logs", {
  summary: "List payment logs",
  params: IdParam,
  responses: {
    200: ServiceInvoicePaymentLogList,
    400: { description: "Invalid id.", schema: ErrorBody },
    404: notFound,
  },
});

r.post("/:id/payment-logs", {
  summary: "Record a payment",
  description:
    "Adds a payment against a `generated` invoice and recomputes its paid/unpaid amounts and payment status. The total paid " +
    "may not exceed the grand total. `paidAt` may be a date or a datetime; it is stored as IST wall-clock time.",
  params: IdParam,
  body: serviceInvoicePaymentLogBodySchema,
  responses: {
    201: { description: "Payment recorded.", schema: ServiceInvoicePaymentLogResult },
    400: { description: "Invalid input, invoice not `generated`, or the payment exceeds the grand total.", schema: ValidationErrorBody },
    403: needsAccountsEdit,
    404: notFound,
  },
});

r.patch("/:id/payment-logs/:logId", {
  summary: "Edit a payment",
  description: "Replaces amount and date of an active payment log; same rules as recording one.",
  body: serviceInvoicePaymentLogBodySchema,
  responses: {
    200: ServiceInvoicePaymentLogResult,
    400: { description: "Invalid ids or input, invoice not `generated`, or the payment exceeds the grand total.", schema: ValidationErrorBody },
    403: needsAccountsEdit,
    404: { description: "Service invoice or payment log not found.", schema: ErrorBody },
  },
});

r.get("/:id", {
  summary: "Get service invoice",
  params: IdParam,
  responses: {
    200: ServiceInvoice,
    400: { description: "Invalid id.", schema: ErrorBody },
    404: notFound,
  },
});

r.post("/", {
  summary: "Create service invoice",
  description:
    "Admin creates a `draft` or `requested` invoice. `auto` invoices take their annexure from lifting logs; `manual` ones " +
    "need `annexureFileBase64` (the xlsx). Quantity/amount totals come from the annexure when it has lines; fee, GST and " +
    "grand total are computed server-side. When requested with an annexure, the annexure PDF is generated; if that fails " +
    "the invoice is not created.",
  body: createServiceInvoiceSchema,
  responses: {
    201: { description: "Created invoice.", schema: ServiceInvoice },
    400: {
      description: "Invalid input, client or plant not found, or the annexure is invalid / its PDF could not be generated.",
      schema: ValidationErrorBody,
    },
    403: needsAdminEdit,
  },
});

r.patch("/:id", {
  summary: "Update service invoice",
  description:
    "Admin edits a `draft` or `recheck` invoice (others are locked); setting `status: requested` submits it to accounts. " +
    "Totals are recomputed and the annexure PDF regenerated when requested; if generation fails the status change is rolled back.",
  params: IdParam,
  body: patchServiceInvoiceSchema,
  responses: {
    200: ServiceInvoice,
    400: {
      description: "Invalid input, invoice locked, plant not found for the client, or annexure invalid / PDF generation failed.",
      schema: ValidationErrorBody,
    },
    403: needsAdminEdit,
    404: notFound,
  },
});

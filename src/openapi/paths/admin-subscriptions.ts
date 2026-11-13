import { z } from "zod";
import {
  accountsSubscriptionInvoiceActionSchema,
  adminSubscriptionInvoiceStatusSchema,
  createSubscriptionBodySchema,
  sendSubscriptionPaymentLinkBodySchema,
  subscriptionBiddersListQuerySchema,
  subscriptionInvoiceUploadFieldsSchema,
  subscriptionStatsQuerySchema,
  subscriptionsExportQuerySchema,
  subscriptionsListQuerySchema,
  updateSubscriptionBodySchema,
} from "../../lib/subscriptions/schemas.js";
import { BinaryFile, ErrorBody, IdParam, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  AdminSubscriptionBidderList,
  AdminSubscriptionBulkEmailResult,
  AdminSubscriptionCreated,
  AdminSubscriptionEmailQueued,
  AdminSubscriptionEntry,
  AdminSubscriptionImportResult,
  AdminSubscriptionList,
  AdminSubscriptionPaymentLinkQueued,
  AdminSubscriptionStats,
} from "../responses/admin-subscriptions.js";
import { SubscriptionQuote } from "../responses/subscriptions.js";

// Docs for src/routes/admin-subscriptions.ts — see docs/api/README.md.
const r = documentRouter("/admin/subscriptions");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// In-handler permission checks (on top of the router gate) answer 403 with `{ error }`.
const needsAccountsEdit = {
  description: "Requires the `subscriptions.accounts-edit` permission (checked in the handler).",
  schema: ErrorBody,
};
const needsAdminEdit = {
  description: "Requires the `module.subscriptions` permission (checked in the handler).",
  schema: ErrorBody,
};
const notFound = { description: "Subscription not found.", schema: ErrorBody };

// Recreated from the inline schema in src/routes/admin-subscriptions.ts.
// `remarks` in lib/subscriptions/schemas.ts is a union with z.undefined() that the OpenAPI
// generator cannot render; the docs use an equivalent optional/nullable string. The
// period refinement (fromDate month >= paymentDate month) still applies at runtime.
const remarksDoc = z
  .string()
  .max(2000)
  .nullable()
  .optional()
  .openapi({ description: "Blank is stored as null." });
const createSubscriptionBodyDoc = createSubscriptionBodySchema.innerType().extend({ remarks: remarksDoc });
const updateSubscriptionBodyDoc = updateSubscriptionBodySchema.innerType().extend({ remarks: remarksDoc });

const bulkSendEmailSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
});

r.get("/", {
  summary: "List subscriptions",
  description:
    "Paginated subscription payments with invoice state, period totals (`totalAmount`, `subscriberCount`) and signed invoice PDF URLs. " +
    "`latestPerBidder=true` keeps only each bidder's latest payment.",
  query: subscriptionsListQuerySchema,
  responses: { 200: AdminSubscriptionList },
});

r.get("/export", {
  summary: "Export subscriptions (xlsx)",
  description:
    "Same filters as the list. `ids` (comma-separated) exports exactly those rows and ignores the filters. Capped at 5000 rows.",
  query: subscriptionsExportQuerySchema,
  responses: { 200: { description: "Excel workbook.", schema: BinaryFile, contentType: XLSX } },
});

r.get("/import/template", {
  summary: "Invoice import template (xlsx)",
  description: "Blank workbook with the columns Invoice Id, Bidder, Invoice no, Invoice PDF.",
  responses: {
    200: { description: "Excel template.", schema: BinaryFile, contentType: XLSX },
    403: needsAccountsEdit,
  },
});

r.post("/import", {
  summary: "Bulk import invoice PDFs",
  description:
    "Accounts uploads the filled template plus the invoice PDFs it references (matched by file name). Each valid row " +
    "attaches its PDF and invoice number to the subscription (same as the single upload: `requested` → `generated`). " +
    "Row problems come back in `issues` (max 2000) rather than as an HTTP error. Limits: xlsx and each PDF 10 MB, up to 5000 PDFs.",
  body: z.object({
    file: BinaryFile.openapi({ description: "Filled import template (.xlsx)." }),
    pdfs: z.array(BinaryFile).openapi({ description: "Invoice PDFs referenced by the sheet (repeat the field)." }),
  }),
  responses: {
    200: AdminSubscriptionImportResult,
    400: { description: "Missing/invalid xlsx, no PDFs, a non-PDF file, or a file over the size limit.", schema: ErrorBody },
    403: needsAccountsEdit,
  },
});

r.post("/bulk-send-email", {
  summary: "Email invoices in bulk",
  description:
    "Queues the subscription invoice email (with the invoice PDF attached) to each bidder's active login email. " +
    "Only `generated` invoices with a PDF are sent; per-id outcomes are in `results`.",
  body: bulkSendEmailSchema,
  responses: { 202: { description: "Emails queued.", schema: AdminSubscriptionBulkEmailResult }, 403: needsAccountsEdit },
});

r.post("/:id/send-email", {
  summary: "Email one invoice",
  description: "Queues the invoice email with the PDF attached to the bidder's active login email.",
  params: IdParam,
  responses: {
    202: { description: "Email queued.", schema: AdminSubscriptionEmailQueued },
    400: {
      description: "Invalid id, invoice not `generated`, bidder has no email, PDF missing, or queueing failed.",
      schema: ErrorBody,
    },
    403: needsAccountsEdit,
    404: notFound,
  },
});

r.get("/bidders", {
  summary: "List bidders by subscription cohort",
  description:
    "`subscribed` = a non-cancelled subscription covers today (IST); `unsubscribed` = none does.",
  query: subscriptionBiddersListQuerySchema,
  responses: { 200: AdminSubscriptionBidderList },
});

r.post("/bidders/:bidderId/send-payment-link", {
  summary: "Email a payment link to a bidder",
  description:
    "Creates an Instamojo order for the plan on the bidder's behalf and queues an email with the checkout link to the " +
    "bidder's login email. When paid, the subscription is recorded via `POST /subscriptions/confirm`.",
  body: sendSubscriptionPaymentLinkBodySchema,
  responses: {
    202: { description: "Payment link email queued.", schema: AdminSubscriptionPaymentLinkQueued },
    400: { description: "Invalid input, the bidder has no login email, or Instamojo rejected the order.", schema: ErrorBody },
    403: needsAdminEdit,
    404: { description: "Bidder not found, or plan not found/inactive.", schema: ErrorBody },
    500: { description: "The email could not be queued.", schema: ErrorBody },
    503: { description: "Online payments (Instamojo) are not configured.", schema: ErrorBody },
  },
});

r.get("/stats", {
  summary: "Subscription stats",
  description: "Total amount, distinct subscribers and per-invoice-status counts, optionally within a date range.",
  query: subscriptionStatsQuerySchema,
  responses: { 200: AdminSubscriptionStats },
});

r.get("/quote", {
  summary: "Quote a plan",
  description:
    "Plan-driven autofill for the admin form: price split and validity period. `fromDate` is normalised to the first of its month (default: current IST month).",
  // Read ad hoc in the handler.
  query: z.object({
    typeId: z.coerce.number().int().positive(),
    fromDate: z.string().optional().openapi({ description: "YYYY-MM-DD." }),
  }),
  responses: {
    200: SubscriptionQuote,
    400: { description: "`typeId` missing or not a positive integer.", schema: ErrorBody },
    404: { description: "Subscription type not found (or has no duration).", schema: ErrorBody },
  },
});

r.post("/", {
  summary: "Record a subscription payment",
  description:
    "Records an offline payment. Amount and `toDate` are always derived from the plan (the sent values are ignored); " +
    "the period starts at `fromDate`'s month, which may not be before the payment month. The invoice starts as `requested` " +
    "and the bidder's validity dates are updated.",
  body: createSubscriptionBodyDoc,
  responses: {
    201: { description: "Subscription recorded.", schema: AdminSubscriptionCreated },
    400: { description: "Invalid input, or the transaction id is already used.", schema: ValidationErrorBody },
    403: needsAdminEdit,
    404: { description: "Subscription type not found.", schema: ErrorBody },
  },
});

r.post("/:id/files/invoice-pdf", {
  summary: "Upload invoice PDF",
  description:
    "Accounts attaches the invoice PDF (max 10 MB) with its number and date. Allowed while `requested` (moves to " +
    "`generated`) or `generated` (replaces the PDF). Invoice numbers are unique.",
  params: IdParam,
  body: subscriptionInvoiceUploadFieldsSchema.extend({ file: BinaryFile }),
  responses: {
    200: AdminSubscriptionEntry,
    400: {
      description: "Invalid fields, missing/invalid PDF, wrong invoice status, or duplicate invoice number.",
      schema: ValidationErrorBody,
    },
    403: needsAccountsEdit,
    404: notFound,
  },
});

r.patch("/:id", {
  summary: "Edit a subscription (recheck)",
  description:
    "Admin corrects payment fields of an invoice that accounts sent back for `recheck`; saving returns it to `requested`. " +
    "Amount and `toDate` are derived from the plan.",
  params: IdParam,
  body: updateSubscriptionBodyDoc,
  responses: {
    200: AdminSubscriptionEntry,
    400: {
      description: "Invalid input, the subscription is not in `recheck`, or the transaction id is already used.",
      schema: ValidationErrorBody,
    },
    403: needsAdminEdit,
    404: { description: "Subscription or subscription type not found.", schema: ErrorBody },
  },
});

r.patch("/:id/accounts", {
  summary: "Accounts invoice action",
  description:
    "Accounts moves the invoice `requested` → `recheck`/`cancelled`, or `recheck`/`generated` → `cancelled`. " +
    "Cancelling recomputes the bidder's validity dates.",
  params: IdParam,
  body: accountsSubscriptionInvoiceActionSchema,
  responses: {
    200: AdminSubscriptionEntry,
    400: { description: "Invalid input or transition not allowed.", schema: ValidationErrorBody },
    403: needsAccountsEdit,
    404: notFound,
  },
});

r.patch("/:id/invoice-status", {
  summary: "Admin invoice status change",
  description: "Admin returns a `recheck` invoice to `requested` without editing it.",
  params: IdParam,
  body: adminSubscriptionInvoiceStatusSchema,
  responses: {
    200: AdminSubscriptionEntry,
    400: { description: "Invalid input or transition not allowed.", schema: ValidationErrorBody },
    403: needsAdminEdit,
    404: notFound,
  },
});

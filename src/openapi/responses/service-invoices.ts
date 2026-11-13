import { SERVICE_FEE_TYPES } from "@auctionit/messages/clients";
import { SERVICE_INVOICE_STATUSES, SERVICE_INVOICE_TYPES } from "@auctionit/messages/service-invoices";
import { z } from "../zod.js";

// Mirrors ServiceInvoiceListRow / ServiceInvoiceListResult / ServiceInvoiceStats / ServiceInvoiceOutstandingStats
// in services/service-invoices.service.ts, ServiceInvoicePaymentLogRow in services/service-invoice-payment-logs.service.ts,
// annexure types in lib/service-invoices/annexure-types.ts and import results in lib/service-invoices/payment-import-types.ts.

export const ServiceInvoiceStatus = z.enum(SERVICE_INVOICE_STATUSES).openapi("ServiceInvoiceStatus", {
  description:
    "Admin saves `draft` or `requested`. Accounts moves `requested` → `generated` (needs invoice no./date/due date and PDFs) " +
    "or `recheck`; admin edits a `recheck` invoice and re-requests it; accounts can cancel a `generated` invoice. " +
    "`cancelled` is fully locked.",
});

export const ServiceInvoice = z
  .object({
    id: z.number().int(),
    clientId: z.number().int(),
    clientName: z.string(),
    plantLocationId: z.number().int(),
    plantLocationName: z.string().nullable(),
    fromDate: z.string().openapi({ description: "Billing period start, YYYY-MM-DD." }),
    toDate: z.string().openapi({ description: "Billing period end, YYYY-MM-DD." }),
    type: z.enum(SERVICE_INVOICE_TYPES).openapi({
      description: "`auto` = annexure built from lifting logs for the period; `manual` = annexure uploaded as xlsx.",
    }),
    orderNumber: z.string().nullable(),
    orderDate: z.string().nullable(),
    gracePeriod: z.number().int().nullable(),
    totalQuantity: z.number(),
    totalAmount: z.number(),
    serviceFeeType: z.enum(SERVICE_FEE_TYPES),
    serviceFeeValue: z.number(),
    serviceFeeAmount: z.number(),
    gstPercent: z.number(),
    gstAmount: z.number(),
    grandTotal: z.number(),
    roundOff: z.number().nullable(),
    serviceChargeDescription: z.string().nullable(),
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    paymentDueDate: z.string().nullable(),
    paidAmount: z.number(),
    unpaidAmount: z.number(),
    latestPaymentDate: z.string().nullable(),
    paymentStatus: z.enum(["unpaid", "partially_paid", "paid"]),
    annexureXlsxFilename: z.string().nullable(),
    annexureXlsxS3Key: z.string().nullable(),
    annexureXlsxUrl: z.string().nullable().openapi({ description: "Signed URL; null when absent or cancelled." }),
    annexurePdfFilename: z.string().nullable(),
    annexurePdfS3Key: z.string().nullable(),
    annexurePdfUrl: z.string().nullable().openapi({ description: "Signed URL; null when absent or cancelled." }),
    invoicePdfFilename: z.string().nullable(),
    invoicePdfS3Key: z.string().nullable(),
    invoicePdfUrl: z.string().nullable().openapi({ description: "Signed URL; null when absent or cancelled." }),
    hasAnnexure: z.boolean(),
    status: ServiceInvoiceStatus,
    requestedAt: z.string().nullable(),
    requestedBy: z.number().int().nullable(),
    generatedAt: z.string().nullable(),
    generatedBy: z.number().int().nullable(),
    emailSentAt: z.string().nullable(),
    emailSentBy: z.number().int().nullable(),
    recheckedAt: z.string().nullable(),
    recheckedBy: z.number().int().nullable(),
    cancelledAt: z.string().nullable(),
    cancelledBy: z.number().int().nullable(),
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi("ServiceInvoice");

export const ServiceInvoiceList = z
  .object({
    items: z.array(ServiceInvoice),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi("ServiceInvoiceList");

export const ServiceInvoiceStats = z
  .object({
    draft: z.number().int(),
    requested: z.number().int(),
    recheck: z.number().int(),
    generated: z.number().int(),
    cancelled: z.number().int(),
    total: z.number().int().openapi({ description: "Non-draft invoices only." }),
  })
  .openapi("ServiceInvoiceStats");

export const ServiceInvoiceOutstandingStats = z
  .object({
    count: z.number().int().openapi({ description: "Generated invoices with an unpaid balance." }),
    amount: z.number().openapi({ description: "Sum of their unpaid amounts." }),
  })
  .openapi("ServiceInvoiceOutstandingStats");

const EmailSendResult = z.object({
  id: z.number().int().openapi({ description: "Service invoice id." }),
  ok: z.boolean(),
  emailLogId: z.number().int().optional(),
  error: z
    .string()
    .optional()
    .openapi({ description: "Why it was not queued (not found, not generated, no billing email, PDF missing…)." }),
});

export const ServiceInvoiceBulkEmailResult = z
  .object({ queued: z.number().int(), results: z.array(EmailSendResult) })
  .openapi("ServiceInvoiceBulkEmailResult");

export const ServiceInvoiceEmailQueued = z
  .object({ ok: z.literal(true), emailLogId: z.number().int() })
  .openapi("ServiceInvoiceEmailQueued");

export const ServiceInvoiceImportIssue = z
  .object({
    rowNumber: z.number().int(),
    kind: z.enum(["error", "skipped", "uploaded"]),
    reason: z.string(),
    fieldErrors: z.record(z.array(z.string())).optional(),
  })
  .openapi("ServiceInvoiceImportIssue");

export const ServiceInvoicePaymentImportResult = z
  .object({
    total: z.number().int(),
    imported: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    message: z.string(),
    issues: z.array(ServiceInvoiceImportIssue),
    issuesTruncated: z.boolean().openapi({ description: "True when more than 2000 issues were found." }),
  })
  .openapi("ServiceInvoicePaymentImportResult");

export const ServiceInvoiceAnnexureLine = z
  .object({
    lineOrder: z.number().int(),
    auctionNumber: z.string(),
    auctionDate: z.string(),
    lotNumber: z.string(),
    product: z.string(),
    approvedQty: z.number(),
    uom: z.string(),
    rankLabel: z.enum(["Winning", ""]).openapi({ description: "Always `Winning`; empty string only on legacy blank rows." }),
    winningPrice: z.number(),
    bidderName: z.string(),
    liftedQty: z.number(),
    amount: z.number(),
  })
  .openapi("ServiceInvoiceAnnexureLine");

export const ServiceInvoiceAnnexureTotals = z
  .object({ totalQuantity: z.number(), totalAmount: z.number() })
  .openapi("ServiceInvoiceAnnexureTotals");

export const ServiceInvoiceAnnexure = z
  .object({ lines: z.array(ServiceInvoiceAnnexureLine), totals: ServiceInvoiceAnnexureTotals })
  .openapi("ServiceInvoiceAnnexure");

export const ServiceInvoiceAnnexureParseResult = z
  .object({
    imported: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    issues: z.array(
      z.object({ row: z.number().int(), field: z.string().optional(), message: z.string() }),
    ),
    lines: z.array(ServiceInvoiceAnnexureLine).optional().openapi({ description: "Absent when the sheet could not be parsed." }),
    totals: ServiceInvoiceAnnexureTotals.optional(),
    filename: z.string().openapi({ description: "Original name of the uploaded file." }),
  })
  .openapi("ServiceInvoiceAnnexureParseResult");

export const ServiceInvoiceSignedUrl = z
  .object({ url: z.string().openapi({ description: "Short-lived signed download URL." }) })
  .openapi("ServiceInvoiceSignedUrl");

export const ServiceInvoicePaymentLog = z
  .object({
    id: z.number().int(),
    serviceInvoiceId: z.number().int(),
    paidAmount: z.number(),
    paidAt: z.string().openapi({ description: "IST wall-clock timestamp without zone, e.g. `2026-10-21T00:00:00`." }),
    createdAt: z.string().nullable(),
    createdBy: z.number().int().nullable(),
    updatedAt: z.string().nullable(),
    updatedBy: z.number().int().nullable(),
  })
  .openapi("ServiceInvoicePaymentLog");

export const ServiceInvoicePaymentLogList = z
  .object({ items: z.array(ServiceInvoicePaymentLog).openapi({ description: "Active logs, newest payment first." }) })
  .openapi("ServiceInvoicePaymentLogList");

export const ServiceInvoicePaymentLogResult = z
  .object({
    log: ServiceInvoicePaymentLog,
    invoice: ServiceInvoice.openapi({ description: "Invoice with recomputed paid/unpaid amounts and payment status." }),
  })
  .openapi("ServiceInvoicePaymentLogResult");

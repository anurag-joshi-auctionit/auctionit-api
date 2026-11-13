import { z } from "../zod.js";
import { SubscriptionEntry } from "./subscriptions.js";

// Mirrors return types of SubscriptionsService (services/subscriptions.service.ts),
// SubscriptionPaymentsService.sendPaymentLinkEmail and SubscriptionInvoiceImportResult
// (lib/subscriptions/invoice-import-types.ts).

export const AdminSubscriptionEntry = SubscriptionEntry.extend({
  invoicePdfS3Key: z.string().nullable().openapi({ description: "Storage key of the invoice PDF; null when none or cancelled." }),
}).openapi("AdminSubscriptionEntry");

export const AdminSubscriptionList = z
  .object({
    items: z.array(AdminSubscriptionEntry),
    total: z.number().int(),
    totalAmount: z.number().openapi({ description: "Sum of `amount` over all matching rows." }),
    subscriberCount: z.number().int().openapi({ description: "Distinct bidders among matching rows." }),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi("AdminSubscriptionList");

export const AdminSubscriptionStats = z
  .object({
    totalAmount: z.number(),
    subscriberCount: z.number().int(),
    requestedCount: z.number().int(),
    recheckCount: z.number().int(),
    generatedCount: z.number().int(),
    cancelledCount: z.number().int(),
  })
  .openapi("AdminSubscriptionStats");

export const AdminSubscriptionBidderRow = z
  .object({
    bidderId: z.number().int(),
    companyName: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    country: z.string().nullable(),
    contactPhone: z.string().nullable(),
    contactEmail: z.string().nullable(),
  })
  .openapi("AdminSubscriptionBidderRow");

export const AdminSubscriptionBidderList = z
  .object({
    items: z.array(AdminSubscriptionBidderRow),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi("AdminSubscriptionBidderList");

export const AdminSubscriptionCreated = z
  .object({
    ok: z.literal(true),
    id: z.number().int().openapi({ description: "New subscription id." }),
    alreadyActive: z
      .boolean()
      .openapi({ description: "The bidder already had an active subscription covering today before this one." }),
  })
  .openapi("AdminSubscriptionCreated");

const EmailSendResult = z.object({
  id: z.number().int().openapi({ description: "Subscription id." }),
  ok: z.boolean(),
  emailLogId: z.number().int().optional(),
  error: z.string().optional().openapi({ description: "Why this row was not queued (not found, not generated, no email, no PDF…)." }),
});

export const AdminSubscriptionBulkEmailResult = z
  .object({
    queued: z.number().int(),
    results: z.array(EmailSendResult),
  })
  .openapi("AdminSubscriptionBulkEmailResult");

export const AdminSubscriptionEmailQueued = z
  .object({ ok: z.literal(true), emailLogId: z.number().int() })
  .openapi("AdminSubscriptionEmailQueued");

export const AdminSubscriptionPaymentLinkQueued = z
  .object({
    ok: z.literal(true),
    emailLogId: z.number().int(),
    merchantTxnId: z.string(),
  })
  .openapi("AdminSubscriptionPaymentLinkQueued");

export const AdminSubscriptionImportIssue = z
  .object({
    rowNumber: z.number().int(),
    kind: z.enum(["error", "skipped", "uploaded"]),
    reason: z.string(),
    fieldErrors: z.record(z.array(z.string())).optional(),
  })
  .openapi("AdminSubscriptionImportIssue");

export const AdminSubscriptionImportResult = z
  .object({
    total: z.number().int(),
    imported: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    message: z.string(),
    issues: z.array(AdminSubscriptionImportIssue),
    issuesTruncated: z.boolean().openapi({ description: "True when more than 2000 issues were found." }),
  })
  .openapi("AdminSubscriptionImportResult");

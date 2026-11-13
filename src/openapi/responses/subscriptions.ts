import { z } from "../zod.js";

// Mirrors SubscriptionEntry / SubscriptionStatus / SubscriptionQuote in services/subscriptions.service.ts
// and TransactionEntry / PaymentVerifyResult in services/subscription-payments.service.ts.

export const SubscriptionInvoiceStatus = z
  .enum(["requested", "recheck", "generated", "cancelled"])
  .openapi("SubscriptionInvoiceStatus", {
    description:
      "Invoice lifecycle: `requested` (payment recorded, awaiting accounts) → `generated` (invoice PDF uploaded). " +
      "Accounts can move requested → recheck/cancelled and recheck/generated → cancelled; admin moves recheck → requested.",
  });

/** SubscriptionEntry without `invoicePdfS3Key` (the bidder portal strips it). */
export const SubscriptionEntry = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    subscriptionTypeId: z.number().int(),
    subscriptionTypeName: z.string().nullable(),
    fromDate: z.string().nullable().openapi({ description: "YYYY-MM-DD, first day of the covered period." }),
    toDate: z.string().nullable().openapi({ description: "YYYY-MM-DD, last day of the covered period." }),
    subscriptionPrice: z.number().openapi({ description: "Amount excluding GST." }),
    gstAmount: z.number(),
    amount: z.number().openapi({ description: "Total paid (plan amount incl. GST)." }),
    paymentMode: z.number().int().nullable().openapi({ description: "Payment type master id (4 = online/Instamojo)." }),
    paymentModeName: z.string().nullable(),
    transactionId: z.string().nullable(),
    paymentDate: z.string().nullable().openapi({ description: "YYYY-MM-DD." }),
    remarks: z.string().nullable(),
    createdAt: z.string(),
    invoiceStatus: SubscriptionInvoiceStatus,
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    invoicePdfFilename: z.string().nullable().openapi({ description: "Null when no PDF or the invoice is cancelled." }),
    invoicePdfUrl: z
      .string()
      .nullable()
      .openapi({ description: "Short-lived signed download URL for the invoice PDF; null when none or cancelled." }),
    invoiceRequestedAt: z.string().nullable(),
    invoiceGeneratedAt: z.string().nullable(),
    invoiceRecheckedAt: z.string().nullable(),
    invoiceCancelledAt: z.string().nullable(),
    emailSentAt: z.string().nullable().openapi({ description: "Null while an invoice email is still queued." }),
    emailSentBy: z.number().int().nullable(),
    emailSentByName: z.string().nullable(),
  })
  .openapi("SubscriptionEntry");

export const SubscriptionStatus = z
  .object({
    active: z.boolean().openapi({ description: "A non-cancelled subscription covers today (IST)." }),
    activeFrom: z.string().nullable(),
    activeUntil: z.string().nullable(),
    currentTypeName: z.string().nullable(),
  })
  .openapi("SubscriptionStatus");

export const SubscriptionHistory = z
  .object({
    items: z.array(SubscriptionEntry),
    status: SubscriptionStatus,
    total: z.number().int(),
    totalAmount: z.number().openapi({ description: "Sum of `amount` over all matching rows." }),
    subscriberCount: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    paymentsEnabled: z.boolean().openapi({ description: "Whether Instamojo online payment is configured." }),
  })
  .openapi("SubscriptionHistory");

export const SubscriptionTransaction = z
  .object({
    id: z.number().int(),
    planName: z.string().nullable(),
    amount: z.number(),
    status: z.enum(["requested", "completed", "failed"]),
    message: z.string().nullable().openapi({ description: "Failure reason from Instamojo, if any." }),
    transactionId: z
      .string()
      .nullable()
      .openapi({ description: "Instamojo payment id, falling back to the merchant txn id." }),
    createdAt: z.string(),
  })
  .openapi("SubscriptionTransaction");

export const SubscriptionTransactionList = z
  .object({
    items: z.array(SubscriptionTransaction),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi("SubscriptionTransactionList");

export const SubscriptionStatusResponse = z
  .object({ status: SubscriptionStatus, paymentsEnabled: z.boolean() })
  .openapi("SubscriptionStatusResponse");

export const SubscriptionQuote = z
  .object({
    subscriptionTypeId: z.number().int(),
    name: z.string(),
    amount: z.number().openapi({ description: "Plan total incl. GST." }),
    gstPercent: z.number(),
    subscriptionPrice: z.number().openapi({ description: "Amount excluding GST." }),
    gstAmount: z.number(),
    fromDate: z.string().openapi({ description: "YYYY-MM-DD." }),
    toDate: z.string().nullable().openapi({ description: "YYYY-MM-DD." }),
  })
  .openapi("SubscriptionQuote");

export const SubscriptionPayInitiation = z
  .object({
    paymentUrl: z.string().openapi({ description: "Instamojo hosted checkout URL to redirect the browser to." }),
    merchantTxnId: z.string().openapi({ description: "`sub_{bidderId}_{FY}_{12hex}`; pass to `/verify` on return." }),
  })
  .openapi("SubscriptionPayInitiation");

export const SubscriptionPaymentVerifyResult = z
  .object({
    status: z.enum(["completed", "pending", "failed"]).openapi({
      description:
        "`completed` = paid and the subscription is recorded (invoice `requested`); `pending` = Instamojo has no final state yet; `failed` = failed/cancelled.",
    }),
  })
  .openapi("SubscriptionPaymentVerifyResult");

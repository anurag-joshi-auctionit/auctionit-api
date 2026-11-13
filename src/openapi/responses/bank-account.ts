import { paginated } from "../common.js";
import { z } from "../zod.js";
import { BidderBankAccount } from "./bidders.js";

// Mirrors BankAccountLogView / BankAccountLogHistoryItem / BankAccountLogCounts in
// services/bidder-bank-account-logs.service.ts and BidderBankAccountView in
// services/bidder-bank-accounts.service.ts.

export const BankAccountUpdateRequest = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    companyName: z.string().nullable(),
    bankAccount: z.string(),
    bankName: z.string(),
    bankIfsc: z.string(),
    cancelledChequeFileName: z.string(),
    cancelledChequeUrl: z
      .string()
      .nullable()
      .openapi({ description: "Signed inline URL of the uploaded cheque; null if signing failed." }),
    isVerified: z
      .boolean()
      .nullable()
      .openapi({ description: "`null` = pending, `true` = accepted, `false` = rejected." }),
    requestedAt: z.string(),
    requestedBy: z.number().int().nullable(),
    requestedByName: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewedBy: z.number().int().nullable(),
    reviewedByName: z.string().nullable(),
    reviewRemark: z.string().nullable(),
  })
  .openapi("BankAccountUpdateRequest");

export const BankAccountPortalSummary = z
  .object({
    account: BidderBankAccount.nullable().openapi({ description: "Live bank details; null if none on file." }),
    pendingRequest: BankAccountUpdateRequest.nullable().openapi({
      description: "The bidder's pending update request, if any.",
    }),
  })
  .openapi("BankAccountPortalSummary");

export const BankAccountHistory = z
  .object({
    items: z.array(
      z
        .object({
          id: z.number().int(),
          bankAccount: z.string(),
          bankName: z.string(),
          bankIfsc: z.string(),
          isVerified: z.boolean().nullable().openapi({ description: "`null` = pending." }),
          requestedAt: z.string(),
          reviewedAt: z.string().nullable(),
        })
        .openapi("BankAccountHistoryItem"),
    ),
  })
  .openapi("BankAccountHistory");

export const BankAccountRequestCounts = z
  .object({ pending: z.number().int(), accepted: z.number().int(), rejected: z.number().int() })
  .openapi("BankAccountRequestCounts");

export const BankAccountRequestList = paginated(BankAccountUpdateRequest, {
  counts: BankAccountRequestCounts,
}).openapi("BankAccountRequestList");

export const BankAccountRequestResult = z
  .object({ message: z.string(), request: BankAccountUpdateRequest })
  .openapi("BankAccountRequestResult");

/** `{ error, issues: ZodError.flatten() }` — this router's own 400 shape (not ValidationErrorBody). */
export const BankAccountIssuesErrorBody = z
  .object({
    error: z.string(),
    issues: z.object({
      formErrors: z.array(z.string()),
      fieldErrors: z.record(z.array(z.string())),
    }),
  })
  .openapi("BankAccountIssuesErrorBody");

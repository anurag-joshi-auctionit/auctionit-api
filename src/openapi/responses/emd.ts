import {
  EMD_BLOCK_STATUSES,
  EMD_FORFEITURE_CLIENT_PAYMENTS,
  EMD_FORFEITURE_STATUSES,
  EMD_FORFEITURE_VIEWS,
  EMD_REFUND_REJECTION_STAGES,
  EMD_REFUND_STATUSES,
  EMD_REFUND_VIEWS,
  EMD_SETTLEMENT_JOB_KINDS,
  EMD_SETTLEMENT_JOB_STATUSES,
  EMD_TRANSFER_STATUSES,
  EMD_TRANSFER_VIEWS,
  EMD_TXN_TYPES,
  EMD_TYPES,
} from "@auctionit/messages/emd";
import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors the return types of services/emd-*.service.ts (and the bank-account /
// disposition / payment-type services used by routes/emd.ts). Amounts are
// rupees as JSON numbers rounded to 2 decimals.

const amount = z.number().openapi({ description: "Amount in rupees (2 decimals).", example: 25000 });

/** `{ count, amount }` bucket used by the refund / forfeiture / transfer summaries. */
export const EmdCountAmount = z
  .object({ count: z.number().int(), amount })
  .openapi("EmdCountAmount");

function viewSummary<T extends readonly [string, ...string[]]>(views: T) {
  return z.object(
    Object.fromEntries(views.map((v) => [v, EmdCountAmount])) as Record<T[number], typeof EmdCountAmount>,
  );
}

/** `{ id, balance }` returned by ledger writes (deposit post/edit, refund raise). */
export const EmdWriteResult = z
  .object({
    id: z.number().int(),
    balance: z.number().openapi({ description: "Bidder's Available EMD balance after the write." }),
  })
  .openapi("EmdWriteResult");

export const EmdUpdatedCount = z
  .object({ updated: z.number().int().openapi({ description: "Rows changed." }) })
  .openapi("EmdUpdatedCount");

// ---- Ledger ----

// bidderOptions() in emd-transactions.service.ts + paymentTypesMasterService.list(true).
export const EmdLedgerOptions = z
  .object({
    bidders: z.array(
      z.object({
        id: z.number().int(),
        name: z.string().openapi({ description: "`Company name (id)`.", example: "Acme Metals (42)" }),
        van: z.string().nullable().openapi({ description: "Bidder's virtual account number." }),
      }),
    ).openapi({ description: "Active, verified bidders ordered by company name." }),
    paymentModes: z.array(z.object({ id: z.number().int(), label: z.string() })).openapi({
      description: "Active payment types.",
    }),
  })
  .openapi("EmdLedgerOptions");

// PassbookEntry / PassbookListResult in emd-transactions.service.ts.
export const EmdPassbookEntry = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    bidderVan: z.string().nullable(),
    emdType: z.enum(EMD_TYPES),
    txnType: z.enum(EMD_TXN_TYPES),
    amount,
    credit: z.number().openapi({ description: "`amount` when a credit, else 0." }),
    debit: z.number().openapi({ description: "`amount` when a debit, else 0." }),
    runningBalance: z.number().nullable().openapi({ description: "Bidder's balance after this entry." }),
    narration: z.string(),
    remarks: z.string().nullable(),
    auctionId: z.number().int().nullable(),
    auctionNumber: z.string().nullable(),
    lots: z.array(z.string()).openapi({
      description: "Lot numbers: the lots recorded on the entry, else the bidder's mapped lots on the auction.",
    }),
    txnRefNo: z.string().nullable(),
    valueDate: z.string().nullable(),
    paymentMode: z.string().nullable(),
    refundId: z.number().int().nullable(),
    refundStatus: z.enum(EMD_REFUND_STATUSES).nullable(),
    reversesTransactionId: z.number().int().nullable(),
    isCorrected: z.boolean().openapi({ description: "Entry has been reversed by a later correction." }),
    isForfeited: z.boolean().openapi({ description: "Legacy `blocked_winning` entry taken by an approved forfeiture." }),
    createdAt: z.string(),
    createdByName: z.string().nullable(),
  })
  .openapi("EmdPassbookEntry");

export const EmdPassbook = paginated(EmdPassbookEntry, {
  balance: z.number().nullable().openapi({ description: "Available balance of the bidder." }),
}).openapi("EmdPassbook");

// EmdDeposit / EmdDepositListResult / EmdDepositSummary in emd-credits.service.ts.
export const EmdDeposit = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    bidderVan: z.string().nullable(),
    amount,
    paymentTypeId: z.number().int().nullable(),
    paymentMode: z.string().nullable(),
    txnRefNo: z.string().nullable(),
    valueDate: z.string().nullable(),
    paidAt: z.string().openapi({ description: "Bank value date, or the posting time when the entry has none." }),
    remarks: z.string().nullable(),
    createdAt: z.string(),
    createdByName: z.string().nullable(),
  })
  .openapi("EmdDeposit");

export const EmdDepositList = paginated(EmdDeposit).openapi("EmdDepositList");

export const EmdDepositSummary = z
  .object({ count: z.number().int(), amount })
  .openapi("EmdDepositSummary");

// ---- Per bidder ----

// EmdBidderSummary in emd-blocks.service.ts.
export const EmdBidderSummary = z
  .object({
    bidderId: z.number().int(),
    bidderName: z.string(),
    van: z.string().nullable(),
    available: z.number().openapi({ description: "Free to block, refund or transfer." }),
    blocked: z.number().openapi({
      description: "Held for auctions the bidder is attached to, including the EMD of won lots until it is released or forfeited.",
    }),
    refundPending: z.number().openapi({ description: "Sum of open refund requests (requested/reviewed/verified)." }),
    forfeited: z.number().openapi({ description: "Sum of approved forfeitures." }),
    total: z.number().openapi({ description: "available + blocked + refundPending." }),
    settlementPendingCount: z.number().int().openapi({
      description: "Auctions of this bidder with a queued/running/paused settlement job.",
    }),
  })
  .openapi("EmdBidderSummary");

// EmdBlocked in emd-blocks.service.ts.
export const EmdBlocked = z
  .object({
    auctionId: z.number().int(),
    auctionNumber: z.string().nullable(),
    clientName: z.string().nullable(),
    blocked: amount,
    blockStatus: z.enum(EMD_BLOCK_STATUSES).nullable(),
    blockedAt: z.string().nullable(),
    auctionStatus: z.string().nullable(),
    settlementStatus: z.enum(EMD_SETTLEMENT_JOB_STATUSES).nullable().openapi({
      description: "Status of the auction's latest settlement job.",
    }),
    lots: z.array(z.string()).openapi({
      description: "Lot numbers covered by the bidder's already-blocked amount on this auction, won lots included.",
    }),
  })
  .openapi("EmdBlocked");

export const EmdBlockedList = paginated(EmdBlocked).openapi("EmdBlockedList");

// BidderBankAccountView in bidder-bank-accounts.service.ts.
export const EmdBidderBankAccount = z
  .object({
    bankAccount: z.string().nullable(),
    bankName: z.string().nullable(),
    bankIfsc: z.string().nullable(),
    cancelledChequeFileName: z.string().nullable(),
    cancelledCheckUrl: z.string().nullable().openapi({ description: "Short-lived signed URL of the cancelled cheque." }),
    isVerified: z.boolean(),
    reviewedAt: z.string().nullable(),
    reviewedBy: z.number().int().nullable(),
    reviewedByName: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi("EmdBidderBankAccount");

export const EmdBidderBankAccountResult = z
  .object({
    bankAccount: EmdBidderBankAccount.nullable().openapi({ description: "Null when the bidder has no bank account." }),
  })
  .openapi("EmdBidderBankAccountResult");

// ---- Blocks ----

// ---- Refunds ----

// EmdRefundRow in emd-refunds.service.ts.
export const EmdRefund = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    bidderVan: z.string().nullable(),
    amount,
    status: z.enum(EMD_REFUND_STATUSES),
    requestedAt: z.string(),
    requestedByName: z.string().nullable(),
    requestedRemarks: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewedByName: z.string().nullable(),
    reviewedRemarks: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    verifiedByName: z.string().nullable(),
    verifiedRemarks: z.string().nullable(),
    txnRefNo: z.string().nullable(),
    paymentDate: z.string().nullable(),
    paymentRemarks: z.string().nullable(),
    paidAt: z.string().nullable(),
    paidByName: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    cancelledByName: z.string().nullable(),
    rejectedStage: z.enum(EMD_REFUND_REJECTION_STAGES).nullable(),
    rejectionReason: z.string().nullable(),
  })
  .openapi("EmdRefund");

export const EmdRefundList = paginated(EmdRefund).openapi("EmdRefundList");

export const EmdRefundSummary = viewSummary(EMD_REFUND_VIEWS).openapi("EmdRefundSummary", {
  description: "Count and amount per refund view.",
});

// ---- Reports ----

// BidderEmdReportRow / BidderEmdReportSummary in emd-reports.service.ts.
export const EmdBidderReportRow = z
  .object({
    bidderId: z.number().int(),
    companyName: z.string(),
    van: z.string().nullable(),
    available: amount,
    blocked: amount,
    refundPending: amount,
    total: amount,
  })
  .openapi("EmdBidderReportRow");

export const EmdBidderReport = paginated(EmdBidderReportRow).openapi("EmdBidderReport");

export const EmdBidderReportSummary = z
  .object({ available: amount, blocked: amount, refundPending: amount, total: amount })
  .openapi("EmdBidderReportSummary");

// ---- Release (EMD held for won lots, pending lifting) ----

// EmdReleaseSummary in emd-release.service.ts.
export const EmdReleaseSummary = z
  .object({
    available: amount,
    blocked: amount,
    refundPending: amount,
    total: amount,
    bidders: z.number().int().openapi({ description: "Bidders with EMD pending lifting." }),
  })
  .openapi("EmdReleaseSummary");

// EmdPendingLot in emd-release.service.ts.
export const EmdPendingLots = z
  .object({
    items: z.array(
      z.object({
        lotId: z.number().int(),
        auctionId: z.number().int(),
        auctionNumber: z.string().nullable(),
        auctionDate: z.string().nullable(),
        clientName: z.string().nullable(),
        lotNumber: z.string().nullable(),
        title: z.string().nullable().openapi({ description: "Name of the lot's first item." }),
        emdRangeId: z.number().int().nullable().openapi({
          description: "EMD range whose hold covers the lot; null when the auction has no ranges or the lot is outside every range.",
        }),
        emdRangeLabel: z.string().nullable().openapi({
          description: "Range label, e.g. \"Lot 3\" or \"Lots 3-4\"; null when the hold has no range.",
        }),
        emdAmount: amount.openapi({
          description:
            "Full EMD configured for the lot's range in EMD Setup; shared by every lot in it. Not the amount currently held, which can be less once a bidder's ranges' EMD sum exceeds the auction's consolidated EMD cap.",
        }),
        lotsInRange: z.number().int().openapi({ description: "Won lots sharing this hold." }),
        forfeitureOpen: z.boolean().openapi({
          description: "A forfeiture request is pending or approved on the range; the lot cannot be released.",
        }),
      }),
    ),
  })
  .openapi("EmdPendingLots");

// EmdReleaseRowResult in emd-release.service.ts.
export const EmdReleaseRowResult = z
  .object({
    lotId: z.number().int(),
    status: z.enum(["released", "cleared", "failed"]).openapi({
      description:
        "`released`: this row completed its EMD range and the credit was posted. `cleared`: the row was saved " +
        "but no money moved yet — either the range still has other pending lots, or every lot in the range is " +
        "decided but the auction's consolidated EMD cap is still consumed by the bidder's other EMD ranges. " +
        "`failed`: the row was not saved.",
    }),
    message: z.string().openapi({ description: "Shown next to the row." }),
  })
  .openapi("EmdReleaseRowResult");

// EmdLotReleaseResult in emd-release.service.ts.
export const EmdLotReleaseResult = z
  .object({
    results: z.array(EmdReleaseRowResult).openapi({
      description: "One result per submitted row, in the same order.",
    }),
    lotsReleased: z.number().int().openapi({ description: "Rows that were accepted (released or cleared)." }),
    rangesReleased: z.number().int(),
    amountReleased: amount,
    balance: z.number().openapi({ description: "Bidder's Available balance after the release." }),
  })
  .openapi("EmdLotReleaseResult");

// EmdReleaseHistoryRow in emd-release.service.ts.
export const EmdReleaseHistoryRow = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    auctionId: z.number().int(),
    auctionNumber: z.string().nullable(),
    lotId: z.number().int(),
    lotNumber: z.string().nullable(),
    title: z.string().nullable(),
    remarks: z.string(),
    requestedAt: z.string().openapi({ description: "When the admin cleared the lot (the release request)." }),
    requestedByName: z.string().nullable().openapi({ description: "Admin who cleared the lot." }),
    releaseId: z.number().int().nullable().openapi({
      description:
        "Credit transaction of the EMD range; null while pending, either because other lots of the range " +
        "are still undecided or because the bidder's other EMD ranges still consume the consolidated EMD cap " +
        "(see `pendingReason`).",
    }),
    releaseAmount: amount.nullable().openapi({
      description:
        "Total credited by this request's release action, including any sibling EMD ranges it swept along, " +
        "not just this row's own range; null while pending. Meaningful only when `releasedWithIds` is empty.",
    }),
    releasedAt: z.string().nullable().openapi({ description: "When the credit posted; null while pending." }),
    releasedWithIds: z.array(z.number().int()).openapi({
      description:
        "Request ids whose release action posted this row's credit, possibly for a different EMD range; " +
        "set when this request was covered by another's, else empty.",
    }),
    releasedByName: z.string().nullable().openapi({ description: "Admin whose request completed the range; null while pending." }),
    pendingReason: z.enum(["within_range", "cross_range"]).optional().openapi({
      description:
        "Why `releaseId` is still null. `within_range`: another lot of the same EMD range hasn't been decided " +
        "yet. `cross_range`: every lot in this range is decided, but the auction's consolidated EMD cap is still " +
        "consumed by the bidder's other EMD ranges. Absent once released.",
    }),
  })
  .openapi("EmdReleaseHistoryRow");

export const EmdReleaseHistory = paginated(EmdReleaseHistoryRow).openapi("EmdReleaseHistory");

// ---- Settlement jobs ----

// EmdSettlementJobRow in emd-settlement.service.ts.
export const EmdSettlementJob = z
  .object({
    id: z.number().int(),
    auctionId: z.number().int(),
    auctionNumber: z.string().nullable(),
    kind: z.enum(EMD_SETTLEMENT_JOB_KINDS),
    lotId: z.number().int().nullable().openapi({ description: "Set for `lot_withdrawn` jobs." }),
    status: z.enum(EMD_SETTLEMENT_JOB_STATUSES),
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    biddersSettled: z.number().int(),
    amountReleased: amount,
    amountHeld: amount.openapi({ description: "EMD kept blocked for won lots after the close." }),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .openapi("EmdSettlementJob");

export const EmdSettlementJobList = paginated(EmdSettlementJob).openapi("EmdSettlementJobList");

export const EmdSettlementResumeResult = z
  .object({ resumed: z.number().int().openapi({ description: "Paused jobs moved back to `queued`." }) })
  .openapi("EmdSettlementResumeResult");

// ---- Forfeitures ----

// EmdForfeitureRow in emd-forfeitures.service.ts.
export const EmdForfeiture = z
  .object({
    id: z.number().int(),
    auctionId: z.number().int(),
    auctionNumber: z.string().nullable(),
    clientId: z.number().int(),
    clientName: z.string().nullable(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    bidderVan: z.string().nullable(),
    emdRangeId: z.number().int().nullable(),
    lotsLabel: z.string().nullable().openapi({ example: "Lots 1–6" }),
    amount,
    dispositionId: z.number().int().nullable(),
    dispositionLabel: z.string().nullable(),
    requestedRemarks: z.string().nullable(),
    status: z.enum(EMD_FORFEITURE_STATUSES),
    clientPayment: z.enum(EMD_FORFEITURE_CLIENT_PAYMENTS).nullable().openapi({
      description: "For forfeited rows: whether the amount is still payable to the client or already paid.",
    }),
    requestedAt: z.string(),
    requestedByName: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewedByName: z.string().nullable(),
    reviewedRemarks: z.string().nullable(),
    clientTxnRefNo: z.string().nullable(),
    paidToClientAt: z.string().nullable(),
    paidToClientByName: z.string().nullable(),
  })
  .openapi("EmdForfeiture");

export const EmdForfeitureList = paginated(EmdForfeiture).openapi("EmdForfeitureList");

export const EmdForfeitureSummary = viewSummary(EMD_FORFEITURE_VIEWS).openapi("EmdForfeitureSummary", {
  description: "Count and amount per forfeiture view. `forfeited` = `payable` + `paid`.",
});

export const EmdForfeitureAuctionOptions = z
  .array(z.object({ auctionId: z.number().int(), auctionNumber: z.string().nullable() }))
  .openapi("EmdForfeitureAuctionOptions");

// EmdForfeitureDispositionDto (= ClientDispositionDto) in services/masters.
export const EmdForfeitureDispositions = z
  .array(
    z.object({
      id: z.string().openapi({ description: "Numeric id serialised as a string.", example: "3" }),
      label: z.string(),
      description: z.string(),
      isActive: z.boolean(),
    }),
  )
  .openapi("EmdForfeitureDispositions");

// EmdForfeitureCandidate in emd-forfeitures.service.ts.
export const EmdForfeitureCandidates = z
  .array(
    z.object({
      auctionId: z.number().int(),
      bidderId: z.number().int(),
      bidderName: z.string().nullable(),
      bidderVan: z.string().nullable(),
      emdRangeId: z.number().int().nullable(),
      lotsLabel: z.string().nullable(),
      lotNumbers: z
        .array(z.string().nullable())
        .nullable()
        .openapi({ description: "Lot numbers covered by this bidder's EMD range, in display order." }),
      blocked: z.number().openapi({ description: "EMD still held for this bidder range that would be forfeited." }),
    }),
  )
  .openapi("EmdForfeitureCandidates");

export const EmdForfeitureRequestResult = z
  .object({ created: z.number().int() })
  .openapi("EmdForfeitureRequestResult");

// ---- Transfers ----

// EmdTransferRow in emd-transfers.service.ts.
export const EmdTransfer = z
  .object({
    id: z.number().int(),
    fromBidderId: z.number().int(),
    fromBidderName: z.string().nullable(),
    fromBidderVan: z.string().nullable(),
    toBidderId: z.number().int(),
    toBidderName: z.string().nullable(),
    toBidderVan: z.string().nullable(),
    amount,
    status: z.enum(EMD_TRANSFER_STATUSES),
    requestedRemarks: z.string(),
    requestedAt: z.string(),
    requestedByName: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewedByName: z.string().nullable(),
    reviewedRemarks: z.string().nullable(),
  })
  .openapi("EmdTransfer");

export const EmdTransferList = paginated(EmdTransfer).openapi("EmdTransferList");

export const EmdTransferSummary = viewSummary(EMD_TRANSFER_VIEWS).openapi("EmdTransferSummary", {
  description: "Count and amount per transfer status.",
});

export const EmdTransferRequestResult = z
  .object({ id: z.number().int() })
  .openapi("EmdTransferRequestResult");

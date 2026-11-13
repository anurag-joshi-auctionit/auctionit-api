import {
  emdBidderReportFilterSchema,
  emdBidderReportQuerySchema,
  emdReleaseHistoryQuerySchema,
  emdCreditSchema,
  emdDepositsQuerySchema,
  emdDepositsSummaryQuerySchema,
  emdDepositUpdateSchema,
  emdForfeitureAuctionOptionsQuerySchema,
  emdForfeitureCandidateAuctionsQuerySchema,
  emdForfeitureCandidatesQuerySchema,
  emdForfeitureListQuerySchema,
  emdForfeiturePayClientSchema,
  emdForfeitureRequestSchema,
  emdForfeitureReviewSchema,
  emdForfeitureSummaryQuerySchema,
  emdPageQuerySchema,
  emdPassbookExportSchema,
  emdPassbookQuerySchema,
  emdRefundDecisionSchema,
  emdRefundListQuerySchema,
  emdRefundPaySchema,
  emdRefundSummaryQuerySchema,
  emdSettlementJobsQuerySchema,
  emdSettlementResumeSchema,
  emdTransferListQuerySchema,
  emdTransferRequestSchema,
  emdTransferReviewSchema,
  emdTransferSummaryQuerySchema,
  emdReleaseLotsSchema,
} from "../../lib/emd/schemas.js";
import { BinaryFile, ErrorBody, IdParam, OkBody, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  EmdBidderBankAccountResult,
  EmdBidderReport,
  EmdBidderReportSummary,
  EmdBidderSummary,
  EmdBlockedList,
  EmdDepositList,
  EmdDepositSummary,
  EmdForfeitureAuctionOptions,
  EmdForfeitureCandidates,
  EmdForfeitureDispositions,
  EmdForfeitureList,
  EmdForfeitureRequestResult,
  EmdForfeitureSummary,
  EmdLedgerOptions,
  EmdPassbook,
  EmdPendingLots,
  EmdRefundList,
  EmdRefundSummary,
  EmdReleaseHistory,
  EmdReleaseSummary,
  EmdSettlementJobList,
  EmdSettlementResumeResult,
  EmdTransferList,
  EmdTransferRequestResult,
  EmdTransferSummary,
  EmdLotReleaseResult,
  EmdUpdatedCount,
  EmdWriteResult,
} from "../responses/emd.js";

// Docs for src/routes/emd.ts — see docs/api/README.md.
// EMD = earnest money deposit. Each bidder has a wallet split into Available
// and Blocked: money held for the auctions they are attached to, which stays
// blocked for the lots they win until it is released or forfeited. Every
// movement is an append-only ledger entry.
// Errors come from EmdError (lib/emd/errors.ts): 404/409 as `{ error }`, and
// 400 domain validation as ValidationErrorBody when tied to a field.
const r = documentRouter("/emd");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const bidderNotFound = { description: "Bidder not found.", schema: ErrorBody };

// ---- Ledger ----

r.get("/bidders/options", {
  summary: "Bidder and payment-mode options for EMD forms",
  description: "Active, verified bidders and active payment modes for the deposit / transfer pickers.",
  responses: { 200: EmdLedgerOptions },
});

r.get("/transactions", {
  summary: "Bidder EMD passbook",
  description:
    "One bidder's ledger entries, newest first, with running balance and the bidder's current Available balance. " +
    "Unlike the bidder portal view, corrected / superseded block entries are included.",
  query: emdPassbookQuerySchema,
  responses: { 200: EmdPassbook },
});

r.get("/transactions/export", {
  summary: "Export bidder EMD passbook",
  description: "One bidder's full passbook as `emd-passbook-<bidderId>-<yyyy-MM-dd>.xlsx`.",
  query: emdPassbookExportSchema,
  responses: { 200: { description: "Passbook workbook.", schema: BinaryFile, contentType: XLSX } },
});

r.post("/credits", {
  summary: "Post EMD deposit",
  description:
    "Records a bidder's EMD deposit as an `emd_deposit` credit; the amount becomes Available immediately. " +
    "The UTR (`txnRefNo`) must be unique per payment mode.",
  body: emdCreditSchema,
  responses: {
    201: { description: "Ledger entry id and the bidder's new Available balance.", schema: EmdWriteResult },
    400: {
      description: "Invalid input, unknown payment mode, or duplicate UTR for the payment mode.",
      schema: ValidationErrorBody,
    },
    404: bidderNotFound,
  },
});

r.get("/credits", {
  summary: "List EMD deposits",
  description:
    "Live deposits (credits not undone by an edit), newest payment first. `from`/`to` filter on the payment date " +
    "(value date, or posting time when absent) in IST. `bidderIds` is comma-separated or repeated.",
  query: emdDepositsQuerySchema,
  responses: { 200: EmdDepositList },
});

r.get("/credits/summary", {
  summary: "EMD deposits summary",
  description: "Count and total amount of the deposits matching the same filters as the list.",
  query: emdDepositsSummaryQuerySchema,
  responses: { 200: EmdDepositSummary },
});

r.put("/credits/:id", {
  summary: "Edit EMD deposit",
  description:
    "Corrects a deposit without rewriting the ledger: posts a `correction_debit` reversing the original and a new " +
    "`emd_deposit` with the corrected values (which may move the money to another bidder). A no-op when nothing " +
    "changed. Each deposit can be edited once; edit the replacement entry afterwards.",
  params: IdParam,
  body: emdDepositUpdateSchema,
  responses: {
    200: { description: "Id of the replacement entry (or the original when unchanged) and the new balance.", schema: EmdWriteResult },
    400: {
      description:
        "Invalid input, unknown payment mode, duplicate UTR, or the original deposit's money is already in use " +
        "(Available too low to reverse it).",
      schema: ValidationErrorBody,
    },
    404: { description: "Deposit not found, or a bidder not found.", schema: ErrorBody },
    409: { description: "The deposit was already edited.", schema: ErrorBody },
  },
});

// ---- Per bidder ----

r.get("/bidders/:bidderId/summary", {
  summary: "Bidder EMD balances",
  description: "Balance cards for one bidder: Available, Blocked, Refund in process, Forfeited and Total.",
  responses: { 200: EmdBidderSummary, 404: bidderNotFound },
});

r.get("/bidders/:bidderId/blocked", {
  summary: "Bidder EMD holdings per auction",
  description: "Blocked EMD per auction for one bidder (non-zero rows only), latest block first.",
  query: emdPageQuerySchema,
  responses: { 200: EmdBlockedList },
});

r.get("/bidders/:bidderId/bank-account", {
  summary: "Bidder bank account for refunds",
  description: "The bidder's current bank account; refunds are paid to it and require it to be verified.",
  responses: { 200: EmdBidderBankAccountResult, 404: bidderNotFound },
});

// ---- Blocks ----

// ---- Release (EMD held for won lots, pending lifting) ----

const releaseRule =
  "The EMD of won lots stays blocked per (auction, bidder, EMD range). A lot is pending until an admin releases it " +
  "(rejected lots are not pending); the range's EMD is credited back as `release_winning_by_admin` only when its " +
  "last pending lot is released, and only the amount that exceeds what the auction's consolidated EMD cap still " +
  "requires the bidder's other EMD ranges to keep blocked — a range can stay (partly) held even once every lot " +
  "in it is decided, until those other ranges free up enough of the cap.";

r.get("/release/bidders", {
  summary: "Bidders with EMD pending lifting",
  description: "Bidder-wise balances, limited to bidders with EMD still held for won lots. `q` matches bidder name or id.",
  query: emdBidderReportQuerySchema,
  responses: { 200: EmdBidderReport },
});

r.get("/release/bidders/summary", {
  summary: "EMD pending lifting totals",
  description: "Totals and bidder count across bidders with EMD pending lifting matching `q` (page cards).",
  query: emdBidderReportFilterSchema,
  responses: { 200: EmdReleaseSummary },
});

r.get("/release/bidders/:bidderId/lots", {
  summary: "Bidder's lots pending lifting",
  description: `Won lots of the bidder still waiting on an admin release, latest auction first. ${releaseRule}`,
  responses: { 200: EmdPendingLots },
});

r.post("/release/bidders/:bidderId/release", {
  summary: "Release won lots",
  description:
    `Checks and saves each row on its own — one invalid row never fails the rows around it. Records every ` +
    `accepted lot as released with its remark (released by/at), and releases any range left with no pending ` +
    `lot. ${releaseRule} Always 200; \`results[]\` carries one outcome per submitted row (\`released\`, ` +
    `\`cleared\` while the row's range is still pending — its own lots, or the consolidated cap — or \`failed\` ` +
    `with the row's message). The ` +
    `400 below is only for a malformed request, not a row-level failure.`,
  body: emdReleaseLotsSchema,
  responses: {
    200: EmdLotReleaseResult,
    400: {
      description: "Invalid request shape: no lots, too many lots, or a bad lot id.",
      schema: ValidationErrorBody,
    },
  },
});

r.get("/release/history", {
  summary: "EMD release history",
  description: "Lot release requests, newest first, with request details and release details (release fields are null while pending — see `pendingReason`). `q` matches bidder, auction or lot. `from`/`to` filter on the request date (IST); `/release/bidders` has no date filter since it is a live balance snapshot, not a dated list.",
  query: emdReleaseHistoryQuerySchema,
  responses: { 200: EmdReleaseHistory },
});

// ---- Refunds ----

const refundFlow =
  "Refund flow: bidder raises (`requested`, amount leaves Available) → admin review (`reviewed`) → accounts " +
  "verify (`verified`) → accounts pay (`paid`). Rejection at review or verify returns the amount to Available.";

r.get("/refunds/summary", {
  summary: "EMD refund counts per view",
  description:
    "Count and amount per view (`to_review`, `to_verify`, `to_pay`, `paid`, `cancelled`, `rejected`). Every view " +
    "filters on the request date (IST).",
  query: emdRefundSummaryQuerySchema,
  responses: { 200: EmdRefundSummary },
});

r.get("/refunds", {
  summary: "List EMD refund requests",
  description: `Refund requests, optionally narrowed to one \`view\`; same date rules as the summary. ${refundFlow}`,
  query: emdRefundListQuerySchema,
  responses: { 200: EmdRefundList },
});

r.post("/refunds/:refundId/review", {
  summary: "Review EMD refund (level 1)",
  description:
    "Admin decision on a `requested` refund: approve → `reviewed`, reject → `rejected` and a `refund_rejected` " +
    `credit returns the amount to Available. Remarks are always required. ${refundFlow}`,
  body: emdRefundDecisionSchema,
  responses: {
    200: OkBody,
    404: { description: "Refund request not found.", schema: ErrorBody },
    409: { description: "The refund is not in `requested` status.", schema: ErrorBody },
  },
});

r.post("/refunds/:refundId/verify", {
  summary: "Verify EMD refund (level 2)",
  description:
    "Accounts decision on a `reviewed` refund: approve → `verified`, reject → `rejected` and the amount returns " +
    `to Available. Remarks are always required. ${refundFlow}`,
  body: emdRefundDecisionSchema,
  responses: {
    200: OkBody,
    404: { description: "Refund request not found.", schema: ErrorBody },
    409: { description: "The refund is not in `reviewed` status.", schema: ErrorBody },
  },
});

r.post("/refunds/:refundId/pay", {
  summary: "Mark EMD refund paid",
  description:
    "Records the payout of a `verified` refund (→ `paid`). The bidder's `refund_requested` ledger entry becomes " +
    "`refund_processed`; no new money moves. `paymentDate` (yyyy-MM-dd) cannot be in the future or before the " +
    "verification date.",
  body: emdRefundPaySchema,
  responses: {
    200: OkBody,
    400: { description: "Invalid input or payment date.", schema: ValidationErrorBody },
    404: { description: "Refund request not found.", schema: ErrorBody },
    409: {
      description: "The refund is not `verified`, or the bidder's bank account is no longer verified.",
      schema: ErrorBody,
    },
  },
});

// ---- Reports ----

r.get("/reports/bidder-wise", {
  summary: "Bidder-wise EMD report",
  description:
    "Per-bidder balances (Available, Blocked, Refund pending, Total). `q` matches bidder name or id; " +
    "empty lists every bidder with EMD activity.",
  query: emdBidderReportQuerySchema,
  responses: { 200: EmdBidderReport },
});

r.get("/reports/bidder-wise/summary", {
  summary: "Bidder-wise EMD report totals",
  description: "Totals across all bidders matching `q` (report cards).",
  query: emdBidderReportFilterSchema,
  responses: { 200: EmdBidderReportSummary },
});

r.get("/reports/bidder-wise/export", {
  summary: "Export bidder-wise EMD report",
  description:
    "All matching rows as `emd-report-<yyyy-MM-dd>.xlsx`. Includes an 'EMD Blocked' sheet listing " +
    "each matching bidder's non-zero per-auction blocked amounts (auction no., date, bidder, lots), " +
    "newest auction first.",
  query: emdBidderReportFilterSchema,
  responses: { 200: { description: "Report workbook.", schema: BinaryFile, contentType: XLSX } },
});

// ---- Settlement jobs ----

r.get("/settlement-jobs", {
  summary: "List EMD settlement jobs",
  description:
    "Auction-level settlement outbox, newest first. A job runs when an auction closes (releases each bidder's block " +
    "except the EMD of the ranges they won, which stays blocked), a lot is withdrawn (releases the block) or on legacy cutover. `status` is " +
    "comma-separated or repeated.",
  query: emdSettlementJobsQuerySchema,
  responses: { 200: EmdSettlementJobList },
});

r.post("/settlement-jobs/resume", {
  summary: "Resume paused settlement jobs",
  description: "Moves `paused` jobs (legacy cutover) back to `queued`; all paused jobs when `jobIds` is omitted or null.",
  body: emdSettlementResumeSchema,
  responses: { 200: EmdSettlementResumeResult },
});

r.post("/settlement-jobs/:jobId/retry", {
  summary: "Retry failed settlement job",
  description: "Re-queues a `failed` job with its attempt counter reset.",
  responses: {
    200: OkBody,
    404: { description: "Settlement job not found.", schema: ErrorBody },
    409: { description: "The job is not `failed`.", schema: ErrorBody },
  },
});

// ---- Forfeitures ----

const forfeitureFlow =
  "Forfeiture flow: propose forfeiting a winner's blocked EMD per bidder range (`requested`) → HOD review " +
  "(`forfeited` or `rejected`) → pay the forfeited amount to the client (`payable` → `paid`).";

r.get("/forfeitures/summary", {
  summary: "EMD forfeiture counts per view",
  description:
    "Count and amount per view (`requested`, `forfeited`, `payable`, `paid`, `rejected`). Dates filter on the " +
    "review date once decided, else the request date. `clientIds`/`auctionIds` are comma-separated or repeated.",
  query: emdForfeitureSummaryQuerySchema,
  responses: { 200: EmdForfeitureSummary },
});

r.get("/forfeitures/auction-options", {
  summary: "Auctions with forfeitures (filter options)",
  description: "Auctions of the selected clients (`clientIds` required) that have forfeitures in the period.",
  query: emdForfeitureAuctionOptionsQuerySchema,
  responses: { 200: EmdForfeitureAuctionOptions },
});

r.get("/forfeitures/dispositions", {
  summary: "Active forfeiture dispositions",
  description: "Reasons a forfeiture can be proposed with (EMD forfeiture disposition master, active only).",
  responses: { 200: EmdForfeitureDispositions },
});

r.get("/forfeitures/candidate-auctions", {
  summary: "Auctions with forfeitable blocked EMD",
  description:
    "Auctions of one client, closed in the period (`from`/`to` on the close date), that still have blocked EMD " +
    "with no open or approved forfeiture.",
  query: emdForfeitureCandidateAuctionsQuerySchema,
  responses: { 200: EmdForfeitureAuctionOptions },
});

r.get("/forfeitures/candidates", {
  summary: "Forfeitable blocked EMD of an auction",
  description: "One row per bidder EMD range with blocked EMD left and no open or approved forfeiture.",
  query: emdForfeitureCandidatesQuerySchema,
  responses: { 200: EmdForfeitureCandidates },
});

r.get("/forfeitures", {
  summary: "List EMD forfeitures",
  description: `Forfeitures, optionally narrowed to one \`view\`; same filters as the summary. ${forfeitureFlow}`,
  query: emdForfeitureListQuerySchema,
  responses: { 200: EmdForfeitureList },
});

r.post("/forfeitures", {
  summary: "Propose EMD forfeitures",
  description:
    "Requests forfeiting the whole blocked amount of each bidder range (all rows or none). Nothing moves " +
    `in the ledger until review. ${forfeitureFlow}`,
  body: emdForfeitureRequestSchema,
  responses: {
    201: { description: "Number of forfeiture requests created.", schema: EmdForfeitureRequestResult },
    400: {
      description:
        "Invalid input, or row problems reported as `items.<index>[.<field>]` field errors: duplicate rows, " +
        "unknown or inactive disposition, a forfeiture already open, or no blocked EMD left.",
      schema: ValidationErrorBody,
    },
    404: { description: "Auction or bidder not found.", schema: ErrorBody },
  },
});

r.post("/forfeitures/review", {
  summary: "Review EMD forfeitures",
  description:
    "HOD decision on pending requests (all or nothing). Approval → `forfeited`: Blocked drops by the amount " +
    "(no new ledger entry) and the bidder is emailed. " +
    `Rejection → \`rejected\`, which frees the range for a new request. ${forfeitureFlow}`,
  body: emdForfeitureReviewSchema,
  responses: {
    200: EmdUpdatedCount,
    404: { description: "A forfeiture was not found.", schema: ErrorBody },
    409: {
      description: "A forfeiture is not `requested`, or a bidder's blocked EMD dropped below the requested amount.",
      schema: ErrorBody,
    },
  },
});

r.post("/forfeitures/pay-client", {
  summary: "Record forfeiture payout to client",
  description:
    "Records one transfer (UTR in `txnRefNo`) to the client covering the selected forfeited rows, moving them " +
    "from `payable` to `paid`. All rows must belong to auctions of the same client.",
  body: emdForfeiturePayClientSchema,
  responses: {
    200: EmdUpdatedCount,
    400: { description: "Invalid input, or the rows span more than one client.", schema: ValidationErrorBody },
    404: { description: "A forfeiture was not found.", schema: ErrorBody },
    409: { description: "A row is not forfeited, or is already paid to the client.", schema: ErrorBody },
  },
});

// ---- Transfers ----

const transferFlow =
  "Transfer flow: propose moving Available EMD from one bidder to another (`requested`, nothing held) → HOD " +
  "review: approve posts `transfer_out` / `transfer_in` entries (`approved`), reject posts nothing (`rejected`).";

r.get("/transfers/summary", {
  summary: "EMD transfer counts per status",
  description:
    "Count and amount per status. Dates filter on the review date once decided, else the request date. " +
    "`bidderId` matches either side.",
  query: emdTransferSummaryQuerySchema,
  responses: { 200: EmdTransferSummary },
});

r.get("/transfers", {
  summary: "List EMD transfers",
  description: `Transfers between bidders, optionally narrowed to one \`view\` (status). ${transferFlow}`,
  query: emdTransferListQuerySchema,
  responses: { 200: EmdTransferList },
});

r.post("/transfers", {
  summary: "Propose EMD transfer",
  description:
    "Both bidders must be active and verified, and the amount must not exceed the source's Available balance " +
    `(re-checked at review). ${transferFlow}`,
  body: emdTransferRequestSchema,
  responses: {
    201: { description: "Id of the transfer request.", schema: EmdTransferRequestResult },
    400: {
      description: "Invalid input, same bidder on both sides, ineligible bidder, or amount exceeds Available.",
      schema: ValidationErrorBody,
    },
    404: bidderNotFound,
  },
});

r.post("/transfers/review", {
  summary: "Review EMD transfers",
  description: `HOD decision on pending transfers (all or nothing). ${transferFlow}`,
  body: emdTransferReviewSchema,
  responses: {
    200: EmdUpdatedCount,
    404: { description: "A transfer or bidder was not found.", schema: ErrorBody },
    409: {
      description: "A transfer is not `requested`, or a source bidder's Available balance no longer covers it.",
      schema: ErrorBody,
    },
  },
});

import { emdPageQuerySchema, emdRefundRaiseSchema } from "../../lib/emd/schemas.js";
import { ErrorBody, OkBody, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  EmdBidderSummary,
  EmdBlockedList,
  EmdForfeitureList,
  EmdPassbook,
  EmdRefundList,
  EmdWriteResult,
} from "../responses/bidder-emd.js";

// Docs for src/routes/bidder-emd.ts — see docs/api/README.md.
// Bidder portal EMD (earnest money deposit): the caller's own balances,
// passbook, holdings, refund requests and forfeitures. Every route answers
// 403 `{ error }` when the logged-in user is not linked to a bidder company.
const r = documentRouter("/bidder-emd");

const notABidder = { description: "Logged-in user is not linked to a bidder company.", schema: ErrorBody };

r.get("/summary", {
  summary: "My EMD balances",
  description: "Balance cards: Available, Blocked, Winning, Refund in process, Forfeited and Total.",
  responses: {
    200: EmdBidderSummary,
    403: notABidder,
    404: { description: "Bidder not found.", schema: ErrorBody },
  },
});

r.get("/transactions", {
  summary: "My EMD passbook",
  description:
    "Own ledger entries, newest first, with running balance. Superseded block entries and their reversals " +
    "(block revisions) are hidden so each auction shows one block row.",
  query: emdPageQuerySchema,
  responses: { 200: EmdPassbook, 403: notABidder },
});

r.get("/blocked", {
  summary: "My EMD holdings per auction",
  description: "Blocked and Winning EMD per auction (non-zero rows only), latest block first.",
  query: emdPageQuerySchema,
  responses: { 200: EmdBlockedList, 403: notABidder },
});

r.get("/refunds", {
  summary: "My EMD refund requests",
  description: "All own refund requests in every status, newest first.",
  query: emdPageQuerySchema,
  responses: { 200: EmdRefundList, 403: notABidder },
});

r.post("/refunds", {
  summary: "Request EMD refund",
  description:
    "Raises a refund (`requested`) and immediately moves the amount out of Available (`refund_requested` debit). " +
    "Requires a verified bank account; the amount cannot exceed Available. Admin review, accounts verification " +
    "and payment follow.",
  body: emdRefundRaiseSchema,
  responses: {
    201: { description: "Refund request id and the new Available balance.", schema: EmdWriteResult },
    400: {
      description: "Invalid input, no verified bank account, or amount exceeds Available.",
      schema: ValidationErrorBody,
    },
    403: notABidder,
    404: { description: "Bidder not found.", schema: ErrorBody },
  },
});

r.post("/refunds/:refundId/cancel", {
  summary: "Cancel my EMD refund request",
  description:
    "Allowed while the request is `requested` or `reviewed` (before accounts verifies). Sets `cancelled` and " +
    "returns the amount to Available (`refund_cancelled` credit).",
  responses: {
    200: OkBody,
    403: notABidder,
    404: { description: "Refund request not found (or not the caller's).", schema: ErrorBody },
    409: { description: "The request can no longer be cancelled.", schema: ErrorBody },
  },
});

r.get("/forfeitures", {
  summary: "My forfeited EMD",
  description: "Own approved forfeitures (Winning EMD taken for won lots), newest first.",
  query: emdPageQuerySchema,
  responses: { 200: EmdForfeitureList, 403: notABidder },
});

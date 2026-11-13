import { z } from "zod";
import { ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import { MasterSubscriptionTypeArray } from "../responses/masters/subscription-types.js";
import {
  SubscriptionHistory,
  SubscriptionPayInitiation,
  SubscriptionPaymentVerifyResult,
  SubscriptionQuote,
  SubscriptionStatusResponse,
  SubscriptionTransactionList,
} from "../responses/subscriptions.js";

// Docs for src/routes/subscriptions.ts — see docs/api/README.md.
const r = documentRouter("/subscriptions");

// Recreated from inline schemas in src/routes/subscriptions.ts.
const confirmSchema = z.object({
  merchantTxnId: z.string().trim().min(1).max(100),
});
const historyListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(["paymentDate", "createdAt", "amount"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});
const transactionsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(["requested", "completed", "failed"]).optional(),
  sortBy: z.enum(["createdAt", "amount", "status"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});
const paySchema = z.object({
  subscriptionTypeId: z.coerce.number().int().positive(),
});

const notBidder = { description: "Logged-in user has no bidder company.", schema: ErrorBody };
const paymentsDisabled = { description: "Online payments (Instamojo) are not configured.", schema: ErrorBody };

r.post("/confirm", {
  summary: "Confirm an Instamojo payment (public)",
  description:
    "Called by the Instamojo return page and by emailed admin payment links, so no login is needed; the unguessable " +
    "`merchantTxnId` (`sub_{bidderId}_{FY}_{12hex}`) identifies the request. Asks Instamojo for the order status and, " +
    "when paid, records the subscription exactly once (invoice status `requested`) and updates the bidder's validity. " +
    "Idempotent.",
  body: confirmSchema,
  responses: {
    200: SubscriptionPaymentVerifyResult,
    404: { description: "No payment request with this merchant txn id.", schema: ErrorBody },
    503: paymentsDisabled,
  },
});

r.get("/", {
  summary: "My subscription history",
  description:
    "The bidder's subscriptions with the current status. First reconciles any still-open Instamojo requests " +
    "(e.g. the bidder closed the checkout tab), recording subscriptions that have since been paid. " +
    "Invoice storage keys are omitted; use `invoicePdfUrl`.",
  query: historyListQuerySchema,
  responses: { 200: SubscriptionHistory, 403: notBidder },
});

r.get("/transactions", {
  summary: "My online payment attempts",
  description: "Instamojo payment requests (requested/completed/failed) with failure messages. Reconciles open requests first.",
  query: transactionsListQuerySchema,
  responses: { 200: SubscriptionTransactionList, 403: notBidder },
});

r.get("/status", {
  summary: "My subscription status",
  description: "Cheap status check (no Instamojo reconcile) used by the app-wide \"not subscribed\" reminder.",
  responses: { 200: SubscriptionStatusResponse, 403: notBidder },
});

r.get("/plans", {
  summary: "Subscription plans",
  description: "Active subscription types the bidder can buy.",
  responses: { 200: MasterSubscriptionTypeArray },
});

r.get("/quote", {
  summary: "Quote a plan",
  description: "Price split and validity period for a plan if paid today; the period starts in the current (IST) month.",
  // Read ad hoc: `Number(req.query.typeId)` must be a positive integer.
  query: z.object({ typeId: z.coerce.number().int().positive() }),
  responses: {
    200: SubscriptionQuote,
    400: { description: "`typeId` missing or not a positive integer.", schema: ErrorBody },
    403: notBidder,
    404: { description: "Subscription type not found (or has no duration).", schema: ErrorBody },
  },
});

r.post("/pay", {
  summary: "Start an online payment",
  description:
    "Creates an Instamojo order for the plan and stores a payment request. Redirect the browser to `paymentUrl`; " +
    "Instamojo returns to the portal, which then calls `GET /subscriptions/verify?txn={merchantTxnId}` " +
    "(or the public `POST /subscriptions/confirm`).",
  body: paySchema,
  responses: {
    200: SubscriptionPayInitiation,
    400: { description: "Invalid input, the bidder has no email, or Instamojo rejected the order.", schema: ErrorBody },
    403: notBidder,
    404: { description: "Plan not found or inactive.", schema: ErrorBody },
    503: paymentsDisabled,
  },
});

r.get("/verify", {
  summary: "Verify my online payment",
  description:
    "Logged-in counterpart of `/confirm`, scoped to the bidder's own requests. On success records the subscription once.",
  // Read ad hoc: `req.query.txn` must be a non-empty string.
  query: z.object({ txn: z.string().min(1).openapi({ description: "merchantTxnId returned by `/pay`." }) }),
  responses: {
    200: SubscriptionPaymentVerifyResult,
    400: { description: "`txn` missing.", schema: ErrorBody },
    403: notBidder,
    404: { description: "No payment request with this txn for this bidder.", schema: ErrorBody },
  },
});

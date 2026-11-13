import { BidderDashboardMessages } from "@auctionit/messages/bidder-dashboard";
import { Router } from "express";
import { z } from "zod";
import { SubscriptionsErrorMessages } from "@auctionit/messages/subscriptions";
import { requireAuth, requirePortalRole } from "../auth/middleware.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  SubscriptionTypeNotFoundError,
  subscriptionsService,
} from "../services/subscriptions.service.js";
import { subscriptionTypesMasterService } from "../services/masters/subscription-types.service.js";
import {
  InstamojoDisabledError,
  SubscriptionPaymentError,
  subscriptionPaymentsService,
} from "../services/subscription-payments.service.js";

const router = Router();

const confirmSchema = z.object({
  merchantTxnId: z.string().trim().min(1).max(100),
});

/**
 * Public confirm for Instamojo return / emailed payment links.
 * merchantTxnId is unguessable (`sub_{bidderId}_{FY}_{12hex}`).
 * Mounted before auth middleware so email payers need not be logged in.
 */
router.post("/confirm", async (req, res, next) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    if (!subscriptionPaymentsService.isEnabled()) {
      res.status(503).json({ error: SubscriptionsErrorMessages.PAYMENTS_DISABLED });
      return;
    }
    // No auth runs on this route, so there is no actor: the subscription is
    // recorded against the user who initiated the payment request.
    const result = await subscriptionPaymentsService.verifyByMerchantTxnId(
      parsed.data.merchantTxnId,
      null,
    );
    res.json(result);
  } catch (e) {
    if (e instanceof SubscriptionPaymentError) {
      res
        .status(e.code === "REQUEST_NOT_FOUND" ? 404 : 400)
        .json({
          error:
            e.code === "REQUEST_NOT_FOUND"
              ? SubscriptionsErrorMessages.PAYMENT_REQUEST_NOT_FOUND
              : e.message,
        });
      return;
    }
    next(e);
  }
});

router.use(requireAuth);
router.use(requirePortalRole("bidder"));

// All routes here are for the logged-in bidder acting on their own company.
function bidderIdOf(req: import("express").Request): number | null {
  return req.user?.bidderId ?? null;
}

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

// The bidder's own subscription status + history (reconciling any pending
// online payments first, e.g. if they closed the Instamojo tab).
router.get("/", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const parsed = historyListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await subscriptionPaymentsService.reconcile(bidderId, req.user!.id);
    const data = await subscriptionsService.listForBidder(
      bidderId,
      parsed.data,
    );
    // Don't expose storage keys to the portal client — signed URL only.
    const items = data.items.map(
      ({ invoicePdfS3Key: _s3Key, ...item }) => item,
    );
    res.json({
      ...data,
      items,
      paymentsEnabled: subscriptionPaymentsService.isEnabled(),
    });
  } catch (e) {
    next(e);
  }
});

// The bidder's payment attempts (succeeded / failed / pending), with messages.
router.get("/transactions", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const parsed = transactionsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await subscriptionPaymentsService.reconcile(bidderId, req.user!.id);
    res.json(
      await subscriptionPaymentsService.listTransactions(
        bidderId,
        parsed.data,
      ),
    );
  } catch (e) {
    next(e);
  }
});

// Lightweight subscription status only (no Instamojo reconcile) — used by the
// app-wide "not subscribed" reminder so it stays cheap on every load.
router.get("/status", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  try {
    const status = await subscriptionsService.getStatus(bidderId);
    res.json({
      status,
      paymentsEnabled: subscriptionPaymentsService.isEnabled(),
    });
  } catch (e) {
    next(e);
  }
});

// Plans the bidder can subscribe to / renew with.
router.get("/plans", async (_req, res, next) => {
  try {
    res.json(await subscriptionTypesMasterService.list(true));
  } catch (e) {
    next(e);
  }
});

// Bidder quote: period from today's payment month (no stacking).
router.get("/quote", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const typeId = Number(req.query.typeId);
  if (!Number.isInteger(typeId) || typeId <= 0) {
    res
      .status(400)
      .json({ error: SubscriptionsErrorMessages.INVALID_SUBSCRIPTION_TYPE_ID });
    return;
  }
  try {
    res.json(await subscriptionsService.quoteForBidder(bidderId, typeId));
  } catch (e) {
    if (e instanceof SubscriptionTypeNotFoundError) {
      res
        .status(404)
        .json({ error: SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NOT_FOUND });
      return;
    }
    next(e);
  }
});

const paySchema = z.object({
  subscriptionTypeId: z.coerce.number().int().positive(),
});

// Start an Instamojo payment: returns the hosted checkout URL to redirect to.
router.post("/pay", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await subscriptionPaymentsService.initiate({
      bidderId,
      subscriptionTypeId: parsed.data.subscriptionTypeId,
      userId: req.user!.id,
      userEmail: req.user!.emailId,
      source: "bidder",
    });
    res.json({
      paymentUrl: result.paymentUrl,
      merchantTxnId: result.merchantTxnId,
    });
  } catch (e) {
    if (e instanceof InstamojoDisabledError) {
      res.status(503).json({ error: SubscriptionsErrorMessages.PAYMENTS_DISABLED });
      return;
    }
    if (e instanceof SubscriptionPaymentError) {
      res.status(e.code === "PLAN_NOT_FOUND" ? 404 : 400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

// Confirm a payment server-side after returning from Instamojo (logged-in bidder).
router.get("/verify", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const txn = typeof req.query.txn === "string" ? req.query.txn : "";
  if (!txn) {
    res
      .status(400)
      .json({ error: SubscriptionsErrorMessages.MISSING_TRANSACTION_REFERENCE });
    return;
  }
  try {
    const result = await subscriptionPaymentsService.verify({
      bidderId,
      merchantTxnId: txn,
      userId: req.user!.id,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof SubscriptionPaymentError) {
      res.status(e.code === "REQUEST_NOT_FOUND" ? 404 : 400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

export default router;

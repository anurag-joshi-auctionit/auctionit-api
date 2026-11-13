import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";
import { SubscriptionsErrorMessages } from "@auctionit/messages/subscriptions";
import { env } from "../env.js";
import { db } from "../db/index.js";
import { bidders } from "../db/schema/bidders.js";
import { users } from "../db/schema/users.js";
import { subscriptionPaymentRequests } from "../db/schema/subscription-payment-requests.js";
import { subscriptionTypes } from "../db/schema/subscription-types.js";
import {
  EMAIL_SOURCE_TYPE_SUBSCRIPTION_PAYMENT_LINK,
} from "../db/schema/notification-email-logs.js";
import { NOTIFICATION_TYPE_SUBSCRIPTION_PAYMENT_LINK } from "../db/schema/notification-types.js";
import { subscriptionsService } from "./subscriptions.service.js";
import {
  InstamojoDisabledError,
  instamojoService,
} from "./instamojo.service.js";
import { clampPagination } from "./list-query.js";
import { formatUtcNow } from "@auctionit/lib/date";
import { enqueueEmails } from "./email-dispatch.service.js";
import {
  buildSubscriptionPaymentLinkEmailHtml,
  buildSubscriptionPaymentLinkEmailSubject,
  formatSubscriptionPaymentLinkEmailAmount,
  SUBSCRIPTION_PAYMENT_LINK_EMAIL_BCC,
  SUBSCRIPTION_PAYMENT_LINK_EMAIL_CC,
} from "../lib/subscriptions/subscription-payment-link-email-template.js";

export { InstamojoDisabledError } from "./instamojo.service.js";

export class SubscriptionPaymentError extends Error {
  constructor(
    message: string,
    public code:
      | "PLAN_NOT_FOUND"
      | "BIDDER_NOT_FOUND"
      | "REQUEST_NOT_FOUND"
      | "EMAIL_REQUIRED"
      | "SEND_FAILED",
  ) {
    super(message);
    this.name = "SubscriptionPaymentError";
  }
}

function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(new Date());
}

function financialYear(dateISO: string): string {
  const [ys, ms] = dateISO.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${start + 1}`;
}

function normalizePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : undefined;
}

export type PaymentInitiation = {
  paymentUrl: string;
  merchantTxnId: string;
  paymentRequestId: number;
};

export type PaymentVerifyResult = {
  status: "completed" | "pending" | "failed";
};

export type TransactionEntry = {
  id: number;
  planName: string | null;
  amount: number;
  status: "requested" | "completed" | "failed";
  message: string | null;
  transactionId: string | null;
  createdAt: string;
};

export class SubscriptionPaymentsService {
  isEnabled(): boolean {
    return instamojoService.isEnabled();
  }

  /** Create an Instamojo order for the plan and persist the request. */
  async initiate(input: {
    bidderId: number;
    subscriptionTypeId: number;
    userId: number;
    userEmail?: string | null;
    source?: "bidder" | "admin";
  }): Promise<PaymentInitiation> {
    if (!this.isEnabled()) throw new InstamojoDisabledError();

    const [plan] = await db
      .select()
      .from(subscriptionTypes)
      .where(eq(subscriptionTypes.id, input.subscriptionTypeId))
      .limit(1);
    if (!plan || !plan.isActive) {
      throw new SubscriptionPaymentError(
        SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NOT_FOUND,
        "PLAN_NOT_FOUND",
      );
    }

    const [bidder] = await db
      .select({
        companyName: bidders.companyName,
        contactEmail: users.emailId,
        contactPhone: users.phoneNumber,
        userActive: users.isActive,
      })
      .from(bidders)
      .leftJoin(users, eq(users.bidderId, bidders.id))
      .where(eq(bidders.id, input.bidderId))
      .limit(1);
    if (!bidder) {
      throw new SubscriptionPaymentError(
        SubscriptionsErrorMessages.BIDDER_NOT_FOUND,
        "BIDDER_NOT_FOUND",
      );
    }

    // Instamojo requires a non-blank buyer email. Prefer the active login
    // user's email, fall back to the session user's email.
    const email =
      (bidder.userActive ? bidder.contactEmail?.trim() : "") ||
      input.userEmail?.trim() ||
      "";
    if (!email) {
      throw new SubscriptionPaymentError(
        SubscriptionsErrorMessages.BIDDER_EMAIL_MISSING,
        "EMAIL_REQUIRED",
      );
    }

    const amount = Number(plan.amount);
    // Merchant reference used as Instamojo transaction_id and our poll key.
    const merchantTxnId = `sub_${input.bidderId}_${financialYear(todayIST())}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const redirectUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/subscriptions/return`;

    const order = await instamojoService.createOrder({
      name: bidder.companyName,
      email,
      phone: normalizePhone(
        bidder.userActive ? bidder.contactPhone : null,
      ),
      amount,
      transactionId: merchantTxnId,
      redirectUrl,
    });

    const [inserted] = await db
      .insert(subscriptionPaymentRequests)
      .values({
        bidderId: input.bidderId,
        subscriptionTypeId: input.subscriptionTypeId,
        merchantTxnId,
        orderId: order.orderId,
        paymentUrl: order.paymentUrl,
        amount: amount.toFixed(2),
        status: "requested",
        source: input.source ?? "bidder",
        initiatedByUserId: input.userId,
      })
      .returning({ id: subscriptionPaymentRequests.id });

    return {
      paymentUrl: order.paymentUrl,
      merchantTxnId,
      paymentRequestId: inserted!.id,
    };
  }

  /**
   * Admin: create an Instamojo order and enqueue a payment-link email to the
   * bidder's active login email.
   */
  async sendPaymentLinkEmail(input: {
    bidderId: number;
    subscriptionTypeId: number;
    adminUserId: number;
  }): Promise<{ ok: true; emailLogId: number; merchantTxnId: string }> {
    if (!this.isEnabled()) throw new InstamojoDisabledError();

    const [bidder] = await db
      .select({
        companyName: bidders.companyName,
        contactEmail: users.emailId,
        userActive: users.isActive,
        planName: subscriptionTypes.name,
        planAmount: subscriptionTypes.amount,
        planActive: subscriptionTypes.isActive,
      })
      .from(bidders)
      .leftJoin(users, eq(users.bidderId, bidders.id))
      .leftJoin(
        subscriptionTypes,
        eq(subscriptionTypes.id, input.subscriptionTypeId),
      )
      .where(eq(bidders.id, input.bidderId))
      .limit(1);

    if (!bidder) {
      throw new SubscriptionPaymentError(
        SubscriptionsErrorMessages.BIDDER_NOT_FOUND,
        "BIDDER_NOT_FOUND",
      );
    }
    if (!bidder.planName || !bidder.planActive) {
      throw new SubscriptionPaymentError(
        SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NOT_FOUND,
        "PLAN_NOT_FOUND",
      );
    }

    const email = bidder.contactEmail?.trim() ?? "";
    if (!email) {
      throw new SubscriptionPaymentError(
        SubscriptionsErrorMessages.BIDDER_EMAIL_MISSING,
        "EMAIL_REQUIRED",
      );
    }

    const initiation = await this.initiate({
      bidderId: input.bidderId,
      subscriptionTypeId: input.subscriptionTypeId,
      userId: input.adminUserId,
      userEmail: email,
      source: "admin",
    });

    const amount = formatSubscriptionPaymentLinkEmailAmount(
      Number(bidder.planAmount),
    );
    const subject = buildSubscriptionPaymentLinkEmailSubject();
    const emailBody = buildSubscriptionPaymentLinkEmailHtml({
      companyName: bidder.companyName,
      planName: bidder.planName,
      amount,
      paymentUrl: initiation.paymentUrl,
    });
    const cc = SUBSCRIPTION_PAYMENT_LINK_EMAIL_CC?.trim() || null;
    const bcc = SUBSCRIPTION_PAYMENT_LINK_EMAIL_BCC?.trim() || null;

    try {
      const { ids } = await enqueueEmails([
        {
          notificationId: NOTIFICATION_TYPE_SUBSCRIPTION_PAYMENT_LINK,
          emailTo: email,
          emailCc: cc,
          emailBcc: bcc,
          subject,
          emailBody,
          sourceType: EMAIL_SOURCE_TYPE_SUBSCRIPTION_PAYMENT_LINK,
          sourceId: initiation.paymentRequestId,
          enqueuedBy: input.adminUserId,
        },
      ]);
      const emailLogId = ids[0];
      if (emailLogId == null) {
        throw new SubscriptionPaymentError(
          SubscriptionsErrorMessages.PAYMENT_LINK_SEND_FAILED,
          "SEND_FAILED",
        );
      }

      await db
        .update(subscriptionPaymentRequests)
        .set({
          emailQueuedAt: formatUtcNow(),
          updatedAt: formatUtcNow(),
        })
        .where(eq(subscriptionPaymentRequests.id, initiation.paymentRequestId));

      return {
        ok: true,
        emailLogId,
        merchantTxnId: initiation.merchantTxnId,
      };
    } catch (e) {
      if (e instanceof SubscriptionPaymentError) throw e;
      throw new SubscriptionPaymentError(
        SubscriptionsErrorMessages.PAYMENT_LINK_SEND_FAILED,
        "SEND_FAILED",
      );
    }
  }

  /**
   * Confirm a payment by merchant txn id alone (email-paid / return page).
   * Resolves the bidder from the payment request row.
   */
  async verifyByMerchantTxnId(
    merchantTxnId: string,
    actorUserId?: number | null,
  ): Promise<PaymentVerifyResult> {
    const [request] = await db
      .select()
      .from(subscriptionPaymentRequests)
      .where(eq(subscriptionPaymentRequests.merchantTxnId, merchantTxnId))
      .limit(1);
    if (!request) {
      throw new SubscriptionPaymentError(
        "Payment request not found",
        "REQUEST_NOT_FOUND",
      );
    }
    return this.completeVerify(request, actorUserId ?? null);
  }

  /**
   * Confirm a payment server-side and, on success, record the subscription.
   * Idempotent: the request row is atomically claimed so concurrent
   * verify/reconcile calls record at most one subscription.
   */
  async verify(input: {
    bidderId: number;
    merchantTxnId: string;
    userId: number;
  }): Promise<PaymentVerifyResult> {
    const [request] = await db
      .select()
      .from(subscriptionPaymentRequests)
      .where(
        and(
          eq(subscriptionPaymentRequests.merchantTxnId, input.merchantTxnId),
          eq(subscriptionPaymentRequests.bidderId, input.bidderId),
        ),
      )
      .limit(1);
    if (!request) {
      throw new SubscriptionPaymentError(
        "Payment request not found",
        "REQUEST_NOT_FOUND",
      );
    }
    return this.completeVerify(request, input.userId);
  }

  private async completeVerify(
    request: typeof subscriptionPaymentRequests.$inferSelect,
    actorUserId: number | null,
  ): Promise<PaymentVerifyResult> {
    if (request.status === "completed") return { status: "completed" };
    if (request.status === "failed") return { status: "failed" };

    const order = await instamojoService.getOrderByTransactionId(
      request.merchantTxnId,
    );
    if (!order) return { status: "pending" };

    if (order.status === "completed") {
      const paid =
        order.payments.find((p) => !p.failure) ?? order.payments[0] ?? null;
      const paymentId = paid?.id || request.merchantTxnId;

      // Atomically claim the request so only one caller records the ledger row.
      const claimed = await db
        .update(subscriptionPaymentRequests)
        .set({
          status: "completed",
          instamojoPaymentId: paymentId,
          updatedAt: formatUtcNow(),
        })
        .where(
          and(
            eq(subscriptionPaymentRequests.id, request.id),
            eq(subscriptionPaymentRequests.status, "requested"),
          ),
        )
        .returning({ id: subscriptionPaymentRequests.id });
      if (claimed.length === 0) return { status: "completed" };

      const recordUserId = await this.resolveRecordUserId(
        request.bidderId,
        actorUserId,
        request.initiatedByUserId,
      );

      try {
        const { id: subscriptionId } = await subscriptionsService.record({
          bidderId: request.bidderId,
          subscriptionTypeId: request.subscriptionTypeId,
          amount: Number(request.amount),
          paymentMode: 4,
          transactionId: paymentId,
          paymentDate: todayIST(),
          remarks:
            request.source === "admin"
              ? "Online payment (Instamojo) — admin payment link"
              : "Online payment (Instamojo)",
          userId: recordUserId,
        });
        await db
          .update(subscriptionPaymentRequests)
          .set({ subscriptionId, updatedAt: formatUtcNow() })
          .where(eq(subscriptionPaymentRequests.id, request.id));
      } catch (e) {
        // Recording failed after the claim — release it so a later reconcile
        // retries rather than silently losing the subscription.
        await db
          .update(subscriptionPaymentRequests)
          .set({ status: "requested", updatedAt: formatUtcNow() })
          .where(eq(subscriptionPaymentRequests.id, request.id));
        throw e;
      }
      return { status: "completed" };
    }

    if (order.status === "failed" || order.status === "cancelled") {
      const failureMessage =
        order.payments.find((p) => p.failure)?.failure ??
        `Payment ${order.status}`;
      await db
        .update(subscriptionPaymentRequests)
        .set({
          status: "failed",
          message: failureMessage.slice(0, 500),
          updatedAt: formatUtcNow(),
        })
        .where(eq(subscriptionPaymentRequests.id, request.id));
      return { status: "failed" };
    }

    return { status: "pending" };
  }

  /** Prefer bidder's active user, then actor, then who initiated the link. */
  private async resolveRecordUserId(
    bidderId: number,
    actorUserId: number | null,
    initiatedByUserId: number | null,
  ): Promise<number> {
    const [bidderUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.bidderId, bidderId), eq(users.isActive, true)))
      .limit(1);
    if (bidderUser?.id) return bidderUser.id;
    if (actorUserId != null && actorUserId > 0) return actorUserId;
    if (initiatedByUserId != null && initiatedByUserId > 0) {
      return initiatedByUserId;
    }
    throw new SubscriptionPaymentError(
      "Unable to attribute subscription payment to a user",
      "REQUEST_NOT_FOUND",
    );
  }

  /** The bidder's Instamojo payment attempts (succeeded / failed / pending). */
  async listTransactions(
    bidderId: number,
    opts: {
      page: number;
      pageSize: number;
      status?: TransactionEntry["status"];
      sortBy?: "createdAt" | "amount" | "status";
      sortOrder?: "asc" | "desc";
    } = { page: 1, pageSize: 10 },
  ): Promise<{
    items: TransactionEntry[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { page, pageSize, offset } = clampPagination(
      opts.page,
      opts.pageSize,
    );
    const conditions: SQL[] = [
      eq(subscriptionPaymentRequests.bidderId, bidderId),
    ];
    if (opts.status) {
      conditions.push(eq(subscriptionPaymentRequests.status, opts.status));
    }
    const whereExpr = and(...conditions);
    const descOrder = (opts.sortOrder ?? "desc") === "desc";
    const sortBy = opts.sortBy ?? "createdAt";
    const primaryCol =
      sortBy === "amount"
        ? subscriptionPaymentRequests.amount
        : sortBy === "status"
          ? subscriptionPaymentRequests.status
          : subscriptionPaymentRequests.createdAt;
    const orderBy = descOrder
      ? [desc(primaryCol), desc(subscriptionPaymentRequests.id)]
      : [asc(primaryCol), asc(subscriptionPaymentRequests.id)];

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: subscriptionPaymentRequests.id,
          planName: subscriptionTypes.name,
          amount: subscriptionPaymentRequests.amount,
          status: subscriptionPaymentRequests.status,
          message: subscriptionPaymentRequests.message,
          transactionId: subscriptionPaymentRequests.instamojoPaymentId,
          merchantTxnId: subscriptionPaymentRequests.merchantTxnId,
          createdAt: subscriptionPaymentRequests.createdAt,
        })
        .from(subscriptionPaymentRequests)
        .leftJoin(
          subscriptionTypes,
          eq(
            subscriptionTypes.id,
            subscriptionPaymentRequests.subscriptionTypeId,
          ),
        )
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(subscriptionPaymentRequests)
        .where(whereExpr),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        planName: r.planName,
        amount: Number(r.amount),
        status: r.status as TransactionEntry["status"],
        message: r.message,
        transactionId: r.transactionId ?? r.merchantTxnId,
        createdAt: r.createdAt,
      })),
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  /** Re-check any still-open requests for a bidder (e.g. closed the tab). */
  async reconcile(bidderId: number, userId: number): Promise<void> {
    if (!this.isEnabled()) return;
    const open = await db
      .select({ merchantTxnId: subscriptionPaymentRequests.merchantTxnId })
      .from(subscriptionPaymentRequests)
      .where(
        and(
          eq(subscriptionPaymentRequests.bidderId, bidderId),
          eq(subscriptionPaymentRequests.status, "requested"),
        ),
      );
    for (const r of open) {
      try {
        await this.verify({ bidderId, merchantTxnId: r.merchantTxnId, userId });
      } catch {
        // Non-fatal: skip this request, the next reconcile will retry.
      }
    }
  }
}

export const subscriptionPaymentsService = new SubscriptionPaymentsService();

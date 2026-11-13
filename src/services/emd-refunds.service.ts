import { and, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatNarrationDate, formatUtcNow, istDateOnly } from "@auctionit/lib/date";
import {
  EMD_REFUND_PROCESSED_NARRATION,
  EMD_REFUND_VIEWS,
  EmdErrorMessages,
  EmdValidationMessages,
  type EmdRefundView,
} from "@auctionit/messages/emd";
import { db } from "../db/index.js";
import {
  bidders,
  emdRefunds,
  emdTransactions,
  users,
  type EmdRefundRejectionStage,
  type EmdRefundStatus,
} from "../db/schema/index.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import { EmdError } from "../lib/emd/errors.js";
import { renderNarration } from "../lib/emd/render-narration.js";
import { combineConditions, clampPagination } from "./list-query.js";
import { emdTransactionsService, type Tx } from "./emd-transactions.service.js";

export type EmdRefundRow = {
  id: number;
  bidderId: number;
  bidderName: string | null;
  bidderVan: string | null;
  amount: number;
  status: EmdRefundStatus;
  requestedAt: string;
  requestedByName: string | null;
  requestedRemarks: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewedRemarks: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  verifiedRemarks: string | null;
  txnRefNo: string | null;
  paymentDate: string | null;
  paymentRemarks: string | null;
  paidAt: string | null;
  paidByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  rejectedStage: EmdRefundRejectionStage | null;
  rejectionReason: string | null;
};

export type EmdRefundFilters = {
  bidderId?: number;
  bidderIds?: number[];
  from?: string;
  to?: string;
};

export type EmdRefundListFilters = EmdRefundFilters & {
  view?: EmdRefundView;
  page: number;
  pageSize: number;
};

type CountAmount = { count: number; amount: number };

export type EmdRefundSummary = Record<EmdRefundView, CountAmount>;

type RefundLevel = "review" | "verify";

const VIEW_STATUS: Record<EmdRefundView, EmdRefundStatus> = {
  to_review: "requested",
  to_verify: "reviewed",
  to_pay: "verified",
  paid: "paid",
  cancelled: "cancelled",
  rejected: "rejected",
};

const BIDDER_CANCELLABLE: EmdRefundStatus[] = ["requested", "reviewed"];

const requester = alias(users, "requester");
const reviewer = alias(users, "reviewer");
const verifier = alias(users, "verifier");
const payer = alias(users, "payer");
const canceller = alias(users, "canceller");

export class EmdRefundsService {
  private async lockRefund(tx: Tx, id: number) {
    const [row] = await tx
      .select()
      .from(emdRefunds)
      .where(eq(emdRefunds.id, id))
      .for("update")
      .limit(1);
    if (!row) throw EmdError.notFound(EmdErrorMessages.REFUND_NOT_FOUND);
    return row;
  }

  private assertStatus(
    status: EmdRefundStatus,
    allowed: EmdRefundStatus[],
  ): void {
    if (!allowed.includes(status))
      throw EmdError.conflict(EmdErrorMessages.REFUND_INVALID_STATUS);
  }

  /** Only verified bidders can raise a refund. */
  private async isBidderVerified(tx: Tx, bidderId: number): Promise<boolean> {
    const [row] = await tx
      .select({ isVerified: bidders.isVerified })
      .from(bidders)
      .where(eq(bidders.id, bidderId))
      .limit(1);
    return row?.isVerified === true;
  }

  /** Bidder raises a refund; the amount leaves Available immediately. */
  async raise(input: {
    bidderId: number;
    amount: number;
    remarks: string;
    userId: number;
  }): Promise<{ id: number; balance: number }> {
    const amount = round2(input.amount);
    const remarks = input.remarks.trim();
    return emdTransactionsService.run(async (tx) => {
      await emdTransactionsService.lockBidders(tx, [input.bidderId]);
      if (!(await this.isBidderVerified(tx, input.bidderId)))
        throw EmdError.validation(EmdErrorMessages.REFUND_BIDDER_NOT_VERIFIED);

      const available = await emdTransactionsService.availableBalance(
        tx,
        input.bidderId,
      );
      if (amount > round2(available)) {
        throw EmdError.validation(
          EmdValidationMessages.REFUND_AMOUNT_EXCEEDS_BALANCE(
            formatCurrency(available),
          ),
          "amount",
        );
      }

      const now = formatUtcNow();
      const [refund] = await tx
        .insert(emdRefunds)
        .values({
          bidderId: input.bidderId,
          amount: amount.toFixed(2),
          status: "requested",
          requestedAt: now,
          requestedBy: input.userId,
          requestedRemarks: remarks,
        })
        .returning({ id: emdRefunds.id });

      await emdTransactionsService.post(tx, {
        bidderId: input.bidderId,
        emdType: "refund_requested",
        amount,
        refundId: refund!.id,
        remarks,
        createdBy: input.userId,
      });
      return {
        id: refund!.id,
        balance: await emdTransactionsService.availableBalance(
          tx,
          input.bidderId,
        ),
      };
    });
  }

  /** Bidder cancel, allowed until accounts verifies; the amount returns to Available. */
  async cancelByBidder(input: {
    refundId: number;
    bidderId: number;
    userId: number;
  }): Promise<void> {
    await emdTransactionsService.run(async (tx) => {
      const refund = await this.lockRefund(tx, input.refundId);
      if (refund.bidderId !== input.bidderId)
        throw EmdError.notFound(EmdErrorMessages.REFUND_NOT_FOUND);
      this.assertStatus(refund.status, BIDDER_CANCELLABLE);
      const now = formatUtcNow();
      await tx
        .update(emdRefunds)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelledBy: input.userId,
          updatedAt: now,
          updatedBy: input.userId,
        })
        .where(eq(emdRefunds.id, refund.id));
      await emdTransactionsService.post(tx, {
        bidderId: refund.bidderId,
        emdType: "refund_cancelled",
        amount: toAmount(refund.amount),
        refundId: refund.id,
        createdBy: input.userId,
      });
    });
  }

  /** Admin (level 1): `requested` → `reviewed`, or reject with remarks. */
  async review(input: {
    refundId: number;
    approve: boolean;
    remarks: string | null;
    userId: number;
  }): Promise<void> {
    await this.decide("review", input);
  }

  /** Accounts (level 2): `reviewed` → `verified`, or reject with remarks. */
  async verify(input: {
    refundId: number;
    approve: boolean;
    remarks: string | null;
    userId: number;
  }): Promise<void> {
    await this.decide("verify", input);
  }

  private async decide(
    level: RefundLevel,
    input: {
      refundId: number;
      approve: boolean;
      remarks: string | null;
      userId: number;
    },
  ): Promise<void> {
    const remarks = input.remarks?.trim() || null;
    if (!remarks) {
      throw EmdError.validation(
        EmdValidationMessages.REASON_REQUIRED,
        "remarks",
      );
    }
    await emdTransactionsService.run(async (tx) => {
      const refund = await this.lockRefund(tx, input.refundId);
      this.assertStatus(refund.status, [
        level === "review" ? "requested" : "reviewed",
      ]);
      const now = formatUtcNow();
      const decision =
        level === "review"
          ? {
              reviewedAt: now,
              reviewedBy: input.userId,
              reviewedRemarks: remarks,
            }
          : {
              verifiedAt: now,
              verifiedBy: input.userId,
              verifiedRemarks: remarks,
            };
      const status: EmdRefundStatus = input.approve
        ? level === "review"
          ? "reviewed"
          : "verified"
        : "rejected";
      await tx
        .update(emdRefunds)
        .set({ ...decision, status, updatedAt: now, updatedBy: input.userId })
        .where(eq(emdRefunds.id, refund.id));
      if (input.approve) return;

      await emdTransactionsService.post(tx, {
        bidderId: refund.bidderId,
        emdType: "refund_rejected",
        amount: toAmount(refund.amount),
        refundId: refund.id,
        remarks,
        createdBy: input.userId,
      });
    });
  }

  /** Accounts records the actual payout of a verified request. */
  async markPaid(input: {
    refundId: number;
    txnRefNo: string;
    paymentDate: string;
    remarks: string | null;
    userId: number;
  }): Promise<void> {
    const txnRefNo = input.txnRefNo.trim();
    if (!txnRefNo)
      throw EmdError.validation(
        EmdValidationMessages.TXN_REF_NO_REQUIRED,
        "txnRefNo",
      );
    if (!input.remarks?.trim())
      throw EmdError.validation(
        EmdValidationMessages.REASON_REQUIRED,
        "remarks",
      );
    if (input.paymentDate > istDateOnly()) {
      throw EmdError.validation(
        EmdValidationMessages.PAYMENT_DATE_IN_FUTURE,
        "paymentDate",
      );
    }
    await emdTransactionsService.run(async (tx) => {
      const refund = await this.lockRefund(tx, input.refundId);
      this.assertStatus(refund.status, ["verified"]);
      const [verified] = await tx
        .select({
          day: sql<
            string | null
          >`to_char(${emdRefunds.verifiedAt} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`,
        })
        .from(emdRefunds)
        .where(eq(emdRefunds.id, refund.id));
      if (verified?.day && input.paymentDate < verified.day) {
        throw EmdError.validation(
          EmdValidationMessages.PAYMENT_DATE_BEFORE_VERIFIED,
          "paymentDate",
        );
      }
      const now = formatUtcNow();
      await tx
        .update(emdRefunds)
        .set({
          status: "paid",
          txnRefNo,
          paymentDate: input.paymentDate,
          paymentRemarks: input.remarks?.trim() || null,
          paidAt: now,
          paidBy: input.userId,
          updatedAt: now,
          updatedBy: input.userId,
        })
        .where(eq(emdRefunds.id, refund.id));
      await tx
        .update(emdTransactions)
        .set({
          emdType: "refund_processed",
          narration: renderNarration(EMD_REFUND_PROCESSED_NARRATION, {
            refundId: refund.id,
            txnRefNo,
            date: formatNarrationDate(input.paymentDate),
          }),
        })
        .where(
          and(
            eq(emdTransactions.refundId, refund.id),
            eq(emdTransactions.emdType, "refund_requested"),
          ),
        );
    });
  }

  private viewCondition(view: EmdRefundView, f: EmdRefundFilters): SQL {
    return and(eq(emdRefunds.status, VIEW_STATUS[view]), ...this.dateConditions(f))!;
  }

  private dateConditions(f: EmdRefundFilters): SQL[] {
    const day = sql`(${emdRefunds.requestedAt} AT TIME ZONE 'Asia/Kolkata')::date`;
    return [
      f.from ? sql`${day} >= CAST(${f.from} AS date)` : undefined,
      f.to ? sql`${day} <= CAST(${f.to} AS date)` : undefined,
    ].filter((c): c is SQL => c != null);
  }

  private bidderConditions(f: EmdRefundFilters): (SQL | undefined)[] {
    return [
      f.bidderId != null ? eq(emdRefunds.bidderId, f.bidderId) : undefined,
      f.bidderIds?.length
        ? inArray(emdRefunds.bidderId, f.bidderIds)
        : undefined,
    ];
  }

  /** Every view follows the date range on the request date (IST). */
  async summary(filters: EmdRefundFilters): Promise<EmdRefundSummary> {
    const bucket = (view: EmdRefundView) => {
      const cond = this.viewCondition(view, filters);
      return {
        n: sql<number>`COUNT(*) FILTER (WHERE ${cond})`.mapWith(Number),
        amount: sql<string>`COALESCE(SUM(${emdRefunds.amount}) FILTER (WHERE ${cond}), 0)`,
      };
    };
    const [row] = await db
      .select(
        Object.fromEntries(
          EMD_REFUND_VIEWS.map((v) => [v, bucket(v)]),
        ) as Record<EmdRefundView, ReturnType<typeof bucket>>,
      )
      .from(emdRefunds)
      .where(combineConditions(this.bidderConditions(filters)));
    const raw = row as
      | Record<EmdRefundView, { n: number; amount: string }>
      | undefined;
    return Object.fromEntries(
      EMD_REFUND_VIEWS.map((v) => [
        v,
        { count: raw?.[v]?.n ?? 0, amount: toAmount(raw?.[v]?.amount) },
      ]),
    ) as EmdRefundSummary;
  }

  async list(filters: EmdRefundListFilters): Promise<{
    items: EmdRefundRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { page, pageSize, offset } = clampPagination(
      filters.page,
      filters.pageSize,
    );
    const viewCond = filters.view
      ? this.viewCondition(filters.view, filters)
      : or(...EMD_REFUND_VIEWS.map((v) => this.viewCondition(v, filters)));
    const where = combineConditions([
      ...this.bidderConditions(filters),
      viewCond,
    ]);
    const [[countRow], rows] = await Promise.all([
      db.select({ n: count() }).from(emdRefunds).where(where),
      db
        .select({
          r: emdRefunds,
          bidderName: bidders.companyName,
          bidderVan: bidders.van,
          requestedByName: requester.name,
          reviewedByName: reviewer.name,
          verifiedByName: verifier.name,
          paidByName: payer.name,
          cancelledByName: canceller.name,
        })
        .from(emdRefunds)
        .leftJoin(bidders, eq(bidders.id, emdRefunds.bidderId))
        .leftJoin(requester, eq(requester.id, emdRefunds.requestedBy))
        .leftJoin(reviewer, eq(reviewer.id, emdRefunds.reviewedBy))
        .leftJoin(verifier, eq(verifier.id, emdRefunds.verifiedBy))
        .leftJoin(payer, eq(payer.id, emdRefunds.paidBy))
        .leftJoin(canceller, eq(canceller.id, emdRefunds.cancelledBy))
        .where(where)
        .orderBy(desc(emdRefunds.requestedAt), desc(emdRefunds.id))
        .limit(pageSize)
        .offset(offset),
    ]);
    return {
      items: rows.map(({ r, ...names }) => {
        const rejected = r.status === "rejected";
        return {
          id: r.id,
          bidderId: r.bidderId,
          bidderName: names.bidderName,
          bidderVan: names.bidderVan,
          amount: toAmount(r.amount),
          status: r.status,
          requestedAt: r.requestedAt,
          requestedByName: names.requestedByName,
          requestedRemarks: r.requestedRemarks,
          reviewedAt: r.reviewedAt,
          reviewedByName: names.reviewedByName,
          reviewedRemarks: r.reviewedRemarks,
          verifiedAt: r.verifiedAt,
          verifiedByName: names.verifiedByName,
          verifiedRemarks: r.verifiedRemarks,
          txnRefNo: r.txnRefNo,
          paymentDate: r.paymentDate,
          paymentRemarks: r.paymentRemarks,
          paidAt: r.paidAt,
          paidByName: names.paidByName,
          cancelledAt: r.cancelledAt,
          cancelledByName: names.cancelledByName,
          rejectedStage: rejected
            ? r.verifiedAt
              ? "accounts"
              : "admin"
            : null,
          rejectionReason: rejected
            ? (r.verifiedRemarks ?? r.reviewedRemarks)
            : null,
        };
      }),
      total: countRow?.n ?? 0,
      page,
      pageSize,
    };
  }
}

export const emdRefundsService = new EmdRefundsService();

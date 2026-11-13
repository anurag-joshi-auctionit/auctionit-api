import { and, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { formatUtcNow } from "@auctionit/lib/date";
import { formatCurrency } from "@auctionit/lib/currency";
import {
  EmdErrorMessages,
  EmdValidationMessages,
  type EmdTransferStatus,
  type EmdTransferView,
} from "@auctionit/messages/emd";
import { db } from "../db/index.js";
import { bidders, emdTransfers, users } from "../db/schema/index.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import { EmdError } from "../lib/emd/errors.js";
import { emdTransactionsService, type Tx } from "./emd-transactions.service.js";
import { clampPagination, combineConditions } from "./list-query.js";

export type EmdTransferRow = {
  id: number;
  fromBidderId: number;
  fromBidderName: string | null;
  fromBidderVan: string | null;
  toBidderId: number;
  toBidderName: string | null;
  toBidderVan: string | null;
  amount: number;
  status: EmdTransferStatus;
  requestedRemarks: string;
  requestedAt: string;
  requestedByName: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewedRemarks: string | null;
};

export type EmdTransferFilters = {
  bidderId?: number;
  from?: string;
  to?: string;
};

export type EmdTransferListFilters = EmdTransferFilters & {
  view?: EmdTransferView;
  page: number;
  pageSize: number;
};

type CountAmount = { count: number; amount: number };
export type EmdTransferSummary = Record<EmdTransferView, CountAmount>;

const requester = alias(users, "requester");
const reviewer = alias(users, "reviewer");

/** Request date as an IST calendar day; the date-range filter applies to it. */
const requestedDaySql = sql`(${emdTransfers.requestedAt} AT TIME ZONE 'Asia/Kolkata')::date`;

/** Review date once decided, request date while pending. */
const periodDateSql = sql`COALESCE(${emdTransfers.reviewedAt}, ${emdTransfers.requestedAt})`;

const VIEW_CONDITIONS: Record<EmdTransferView, SQL> = {
  requested: eq(emdTransfers.status, "requested"),
  approved: eq(emdTransfers.status, "approved"),
  rejected: eq(emdTransfers.status, "rejected"),
};

export class EmdTransfersService {
  private async lockMany(tx: Tx, ids: number[]) {
    const unique = [...new Set(ids)];
    const rows = await tx
      .select()
      .from(emdTransfers)
      .where(inArray(emdTransfers.id, unique))
      .orderBy(emdTransfers.id)
      .for("update");
    if (rows.length !== unique.length) throw EmdError.notFound(EmdErrorMessages.TRANSFER_NOT_FOUND);
    return rows;
  }

  /** Company name for the narration's counterparty placeholder. */
  private async bidderNames(tx: Tx, ids: number[]): Promise<Map<number, string>> {
    const rows = await tx
      .select({ id: bidders.id, name: bidders.companyName })
      .from(bidders)
      .where(inArray(bidders.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r.name ?? `#${r.id}`]));
  }

  private filterConditions(f: EmdTransferFilters): (SQL | undefined)[] {
    return [
      f.bidderId != null
        ? or(eq(emdTransfers.fromBidderId, f.bidderId), eq(emdTransfers.toBidderId, f.bidderId))
        : undefined,
      f.from ? sql`${requestedDaySql} >= CAST(${f.from} AS date)` : undefined,
      f.to ? sql`${requestedDaySql} <= CAST(${f.to} AS date)` : undefined,
    ];
  }

  /**
   * Proposes moving withdrawable EMD between two wallets; the HOD reviews it.
   * Nothing is posted to the ledger here — the balance is checked again at
   * review time, because a pending request holds no money.
   */
  async request(input: {
    fromBidderId: number;
    toBidderId: number;
    amount: number;
    requestedRemarks: string;
    userId: number;
  }): Promise<{ id: number }> {
    if (input.fromBidderId === input.toBidderId) {
      throw EmdError.validation(EmdValidationMessages.TRANSFER_SAME_BIDDER, "toBidderId");
    }
    const amount = round2(input.amount);
    return emdTransactionsService.run(async (tx) => {
      const eligible = await tx
        .select({ id: bidders.id })
        .from(bidders)
        .where(
          and(
            inArray(bidders.id, [input.fromBidderId, input.toBidderId]),
            eq(bidders.isActive, true),
            eq(bidders.isVerified, true),
          ),
        );
      if (eligible.length !== 2) {
        throw EmdError.validation(EmdErrorMessages.TRANSFER_BIDDER_NOT_ELIGIBLE, "fromBidderId");
      }

      await emdTransactionsService.lockBidders(tx, [input.fromBidderId]);
      const available = await emdTransactionsService.availableBalance(tx, input.fromBidderId);
      if (amount > round2(available)) {
        throw EmdError.validation(
          EmdValidationMessages.TRANSFER_AMOUNT_EXCEEDS_BALANCE(formatCurrency(available)),
          "amount",
        );
      }

      const [row] = await tx
        .insert(emdTransfers)
        .values({
          fromBidderId: input.fromBidderId,
          toBidderId: input.toBidderId,
          amount: amount.toFixed(2),
          requestedRemarks: input.requestedRemarks,
          status: "requested",
          requestedBy: input.userId,
          requestedAt: formatUtcNow(),
        })
        .returning({ id: emdTransfers.id });
      return { id: row!.id };
    });
  }

  /**
   * HOD review of pending requests (all or nothing). Approval moves the money:
   * one `transfer_out` debit on each source and one `transfer_in` credit on each
   * target, posted together so the Available guard sees the net per bidder.
   */
  async review(input: {
    ids: number[];
    approve: boolean;
    remarks: string;
    userId: number;
  }): Promise<{ updated: number }> {
    if (!input.remarks?.trim()) {
      throw EmdError.validation(EmdValidationMessages.REASON_REQUIRED, "remarks");
    }
    return emdTransactionsService.run(async (tx) => {
      const locked = await this.lockMany(tx, input.ids);
      if (locked.some((r) => r.status !== "requested")) {
        throw EmdError.conflict(EmdErrorMessages.TRANSFER_INVALID_STATUS);
      }

      const now = formatUtcNow();
      await tx
        .update(emdTransfers)
        .set({
          status: input.approve ? "approved" : "rejected",
          reviewedBy: input.userId,
          reviewedAt: now,
          reviewedRemarks: input.remarks,
          updatedAt: now,
          updatedBy: input.userId,
        })
        .where(
          inArray(
            emdTransfers.id,
            locked.map((r) => r.id),
          ),
        );
      if (!input.approve) return { updated: locked.length };

      const bidderIds = [...new Set(locked.flatMap((r) => [r.fromBidderId, r.toBidderId]))];
      await emdTransactionsService.lockBidders(tx, bidderIds);
      // The request-time check can be stale: nothing was held, so the source may
      // have spent the money since. Re-check before posting.
      const requestedBySource = new Map<number, number>();
      for (const r of locked) {
        const amount = round2(toAmount(r.amount));
        requestedBySource.set(r.fromBidderId, round2((requestedBySource.get(r.fromBidderId) ?? 0) + amount));
      }
      for (const [bidderId, total] of requestedBySource) {
        const available = await emdTransactionsService.availableBalance(tx, bidderId);
        if (total > round2(available)) {
          throw EmdError.conflict(EmdErrorMessages.TRANSFER_BALANCE_CHANGED);
        }
      }

      const names = await this.bidderNames(tx, bidderIds);
      const inputs = locked.flatMap((r) => {
        const amount = round2(toAmount(r.amount));
        return [
          {
            bidderId: r.fromBidderId,
            emdType: "transfer_out" as const,
            amount,
            transferId: r.id,
            remarks: r.requestedRemarks,
            narrationValues: { counterparty: names.get(r.toBidderId), remarks: r.requestedRemarks },
            createdBy: input.userId,
          },
          {
            bidderId: r.toBidderId,
            emdType: "transfer_in" as const,
            amount,
            transferId: r.id,
            remarks: r.requestedRemarks,
            narrationValues: { counterparty: names.get(r.fromBidderId), remarks: r.requestedRemarks },
            createdBy: input.userId,
          },
        ];
      });
      await emdTransactionsService.postMany(tx, inputs);
      return { updated: locked.length };
    });
  }

  async list(filters: EmdTransferListFilters): Promise<{
    items: EmdTransferRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { page, pageSize, offset } = clampPagination(filters.page, filters.pageSize);
    const fromBidder = alias(bidders, "from_bidder");
    const toBidder = alias(bidders, "to_bidder");
    const where = combineConditions([
      ...this.filterConditions(filters),
      filters.view ? VIEW_CONDITIONS[filters.view] : undefined,
    ]);

    const [[countRow], rows] = await Promise.all([
      db.select({ n: count() }).from(emdTransfers).where(where),
      db
        .select({
          t: emdTransfers,
          fromBidderName: fromBidder.companyName,
          fromBidderVan: fromBidder.van,
          toBidderName: toBidder.companyName,
          toBidderVan: toBidder.van,
          requestedByName: requester.name,
          reviewedByName: reviewer.name,
        })
        .from(emdTransfers)
        .leftJoin(fromBidder, eq(fromBidder.id, emdTransfers.fromBidderId))
        .leftJoin(toBidder, eq(toBidder.id, emdTransfers.toBidderId))
        .leftJoin(requester, eq(requester.id, emdTransfers.requestedBy))
        .leftJoin(reviewer, eq(reviewer.id, emdTransfers.reviewedBy))
        .where(where)
        .orderBy(desc(periodDateSql), desc(emdTransfers.id))
        .limit(pageSize)
        .offset(offset),
    ]);

    return {
      items: rows.map(({ t, ...r }) => ({
        id: t.id,
        fromBidderId: t.fromBidderId,
        fromBidderName: r.fromBidderName,
        fromBidderVan: r.fromBidderVan,
        toBidderId: t.toBidderId,
        toBidderName: r.toBidderName,
        toBidderVan: r.toBidderVan,
        amount: toAmount(t.amount),
        status: t.status,
        requestedRemarks: t.requestedRemarks,
        requestedAt: t.requestedAt,
        requestedByName: r.requestedByName,
        reviewedAt: t.reviewedAt,
        reviewedByName: r.reviewedByName,
        reviewedRemarks: t.reviewedRemarks,
      })),
      total: countRow?.n ?? 0,
      page,
      pageSize,
    };
  }

  /** One pass over the filtered rows; every bucket follows the same period. */
  async summary(filters: EmdTransferFilters): Promise<EmdTransferSummary> {
    const bucket = (view: EmdTransferView) => ({
      n: sql<number>`COUNT(*) FILTER (WHERE ${VIEW_CONDITIONS[view]})`.mapWith(Number),
      amount: sql<string>`COALESCE(SUM(${emdTransfers.amount}) FILTER (WHERE ${VIEW_CONDITIONS[view]}), 0)`,
    });
    const [row] = await db
      .select({
        requested: bucket("requested"),
        approved: bucket("approved"),
        rejected: bucket("rejected"),
      })
      .from(emdTransfers)
      .where(combineConditions(this.filterConditions(filters)));
    const pick = (b: { n: number; amount: string } | undefined): CountAmount => ({
      count: b?.n ?? 0,
      amount: toAmount(b?.amount),
    });
    return {
      requested: pick(row?.requested),
      approved: pick(row?.approved),
      rejected: pick(row?.rejected),
    };
  }
}

export const emdTransfersService = new EmdTransfersService();

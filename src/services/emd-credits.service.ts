import { and, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { EmdErrorMessages, EmdUiMessages } from "@auctionit/messages/emd";
import { db } from "../db/index.js";
import { bidders, emdTransactions, paymentTypes, users } from "../db/schema/index.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import { EmdError } from "../lib/emd/errors.js";
import { emdTransactionsService, type Tx } from "./emd-transactions.service.js";
import { clampPagination, combineConditions } from "./list-query.js";

export type EmdCreditInput = {
  bidderId: number;
  amount: number;
  paymentTypeId: number;
  valueDate: string | null;
  txnRefNo: string | null;
  remarks: string | null;
  userId: number;
};

/** Drive both the summary cards and the list. */
export type EmdDepositFilters = {
  bidderIds?: number[];
  from?: string;
  to?: string;
};

export type EmdDepositSummary = { count: number; amount: number };

export type EmdDeposit = {
  id: number;
  bidderId: number;
  bidderName: string | null;
  bidderVan: string | null;
  amount: number;
  paymentTypeId: number | null;
  paymentMode: string | null;
  txnRefNo: string | null;
  valueDate: string | null;
  /** Bank value date, or the posting time when the entry has none. */
  paidAt: string;
  remarks: string | null;
  createdAt: string;
  createdByName: string | null;
};

export type EmdDepositListResult = {
  items: EmdDeposit[];
  total: number;
  page: number;
  pageSize: number;
};

/** Credits not undone by a linked correction; an edit reverses the original entry. */
const notReversed = sql`NOT EXISTS (
  SELECT 1 FROM emd_transactions r WHERE r.reverses_transaction_id = ${emdTransactions.id}
)`;

const paidAt = sql<string>`COALESCE(${emdTransactions.valueDate}, ${emdTransactions.createdAt})`;

function sameInstant(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

export class EmdCreditsService {
  private async paymentModeName(tx: Tx, paymentTypeId: number): Promise<string> {
    const [mode] = await tx
      .select({ name: paymentTypes.name })
      .from(paymentTypes)
      .where(eq(paymentTypes.id, paymentTypeId))
      .limit(1);
    if (!mode) {
      throw EmdError.validation(EmdErrorMessages.PAYMENT_MODE_NOT_FOUND, "paymentTypeId");
    }
    return mode.name;
  }

  private async assertUniqueUtr(
    tx: Tx,
    paymentTypeId: number,
    utr: string | null,
    excludeId?: number,
  ): Promise<void> {
    if (!utr) return;
    const [dup] = await tx
      .select({ id: emdTransactions.id })
      .from(emdTransactions)
      .where(
        and(
          eq(emdTransactions.emdType, "emd_deposit"),
          eq(emdTransactions.paymentTypeId, paymentTypeId),
          sql`upper(${emdTransactions.txnRefNo}) = upper(${utr})`,
          notReversed,
          excludeId != null ? ne(emdTransactions.id, excludeId) : undefined,
        ),
      )
      .limit(1);
    if (dup) throw EmdError.validation(EmdErrorMessages.DUPLICATE_UTR, "txnRefNo");
  }

  /** Single-entry EMD credit (legacy "Upload EMD" form). */
  async post(input: EmdCreditInput): Promise<{ id: number; balance: number }> {
    const txnRefNo = input.txnRefNo?.trim() || null;
    return emdTransactionsService.run(async (tx) => {
      const paymentMode = await this.paymentModeName(tx, input.paymentTypeId);
      await this.assertUniqueUtr(tx, input.paymentTypeId, txnRefNo);
      const id = await emdTransactionsService.post(tx, {
        bidderId: input.bidderId,
        emdType: "emd_deposit",
        amount: input.amount,
        paymentTypeId: input.paymentTypeId,
        txnRefNo,
        valueDate: input.valueDate,
        remarks: input.remarks,
        narrationValues: { paymentMode, date: input.valueDate?.slice(0, 10) },
        createdBy: input.userId,
      });
      return { id, balance: await emdTransactionsService.availableBalance(tx, input.bidderId) };
    });
  }

  /**
   * Edits a deposit without rewriting the ledger: reverses the original with a
   * linked correction debit and posts the corrected credit in its place.
   */
  async update(id: number, input: EmdCreditInput): Promise<{ id: number; balance: number }> {
    const txnRefNo = input.txnRefNo?.trim() || null;
    return emdTransactionsService.run(async (tx) => {
      const [orig] = await tx
        .select({
          bidderId: emdTransactions.bidderId,
          amount: emdTransactions.amount,
          paymentTypeId: emdTransactions.paymentTypeId,
          txnRefNo: emdTransactions.txnRefNo,
          valueDate: emdTransactions.valueDate,
          remarks: emdTransactions.remarks,
        })
        .from(emdTransactions)
        .where(and(eq(emdTransactions.id, id), eq(emdTransactions.emdType, "emd_deposit")))
        .limit(1);
      if (!orig) throw EmdError.notFound(EmdErrorMessages.TRANSACTION_NOT_FOUND);

      await emdTransactionsService.lockBidders(tx, [orig.bidderId, input.bidderId]);
      const [reversal] = await tx
        .select({ id: emdTransactions.id })
        .from(emdTransactions)
        .where(eq(emdTransactions.reversesTransactionId, id))
        .limit(1);
      if (reversal) throw EmdError.conflict(EmdErrorMessages.DEPOSIT_ALREADY_EDITED);

      const unchanged =
        orig.bidderId === input.bidderId &&
        round2(toAmount(orig.amount)) === round2(input.amount) &&
        orig.paymentTypeId === input.paymentTypeId &&
        (orig.txnRefNo ?? null) === txnRefNo &&
        sameInstant(orig.valueDate, input.valueDate) &&
        (orig.remarks ?? null) === (input.remarks?.trim() || null);
      if (unchanged) {
        return { id, balance: await emdTransactionsService.availableBalance(tx, input.bidderId) };
      }

      const paymentMode = await this.paymentModeName(tx, input.paymentTypeId);
      await this.assertUniqueUtr(tx, input.paymentTypeId, txnRefNo, id);

      let newId: number;
      try {
        const ids = await emdTransactionsService.postMany(tx, [
          {
            bidderId: orig.bidderId,
            emdType: "correction_debit",
            amount: toAmount(orig.amount),
            reversesTransactionId: id,
            createdBy: input.userId,
          },
          {
            bidderId: input.bidderId,
            emdType: "emd_deposit",
            amount: input.amount,
            paymentTypeId: input.paymentTypeId,
            txnRefNo,
            valueDate: input.valueDate,
            remarks: input.remarks,
            reference: EmdUiMessages.DEPOSIT_REPLACES_REFERENCE(id),
            narrationValues: { paymentMode, date: input.valueDate?.slice(0, 10) },
            createdBy: input.userId,
          },
        ]);
        newId = ids[1]!;
      } catch (e) {
        if (e instanceof EmdError && e.message === EmdErrorMessages.INSUFFICIENT_BALANCE) {
          throw EmdError.validation(EmdErrorMessages.DEPOSIT_FUNDS_IN_USE, "amount");
        }
        throw e;
      }
      return {
        id: newId,
        balance: await emdTransactionsService.availableBalance(tx, input.bidderId),
      };
    });
  }

  private filterConditions(f: EmdDepositFilters): SQL | undefined {
    const day = sql`(${paidAt} AT TIME ZONE 'Asia/Kolkata')::date`;
    return combineConditions([
      eq(emdTransactions.emdType, "emd_deposit"),
      notReversed,
      f.bidderIds?.length ? inArray(emdTransactions.bidderId, f.bidderIds) : undefined,
      f.from ? sql`${day} >= CAST(${f.from} AS date)` : undefined,
      f.to ? sql`${day} <= CAST(${f.to} AS date)` : undefined,
    ]);
  }

  /** Bidder deposits (live `credit` entries), newest payment first. */
  async list(
    opts: EmdDepositFilters & { page: number; pageSize: number },
  ): Promise<EmdDepositListResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const where = this.filterConditions(opts);

    const [[countRow], rows] = await Promise.all([
      db.select({ n: count() }).from(emdTransactions).where(where),
      db
        .select({
          id: emdTransactions.id,
          bidderId: emdTransactions.bidderId,
          bidderName: bidders.companyName,
          bidderVan: bidders.van,
          amount: emdTransactions.amount,
          paymentTypeId: emdTransactions.paymentTypeId,
          paymentMode: paymentTypes.name,
          txnRefNo: emdTransactions.txnRefNo,
          bankTransactionId: emdTransactions.bankTransactionId,
          valueDate: emdTransactions.valueDate,
          paidAt,
          remarks: emdTransactions.remarks,
          createdAt: emdTransactions.createdAt,
          createdByName: users.name,
        })
        .from(emdTransactions)
        .leftJoin(bidders, eq(bidders.id, emdTransactions.bidderId))
        .leftJoin(paymentTypes, eq(paymentTypes.id, emdTransactions.paymentTypeId))
        .leftJoin(users, eq(users.id, emdTransactions.createdBy))
        .where(where)
        .orderBy(desc(paidAt), desc(emdTransactions.id))
        .limit(pageSize)
        .offset(offset),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        bidderId: r.bidderId,
        bidderName: r.bidderName,
        bidderVan: r.bidderVan,
        amount: toAmount(r.amount),
        paymentTypeId: r.paymentTypeId,
        paymentMode: r.paymentMode,
        txnRefNo: r.txnRefNo ?? r.bankTransactionId,
        valueDate: r.valueDate,
        paidAt: r.paidAt,
        remarks: r.remarks,
        createdAt: r.createdAt,
        createdByName: r.createdByName,
      })),
      total: countRow?.n ?? 0,
      page,
      pageSize,
    };
  }

  /** Count and amount of the deposits matching the list filters. */
  async summary(filters: EmdDepositFilters): Promise<EmdDepositSummary> {
    const [row] = await db
      .select({
        n: count(),
        amount: sql<string>`COALESCE(SUM(${emdTransactions.amount}), 0)`,
      })
      .from(emdTransactions)
      .where(this.filterConditions(filters));
    return { count: row?.n ?? 0, amount: toAmount(row?.amount) };
  }
}

export const emdCreditsService = new EmdCreditsService();

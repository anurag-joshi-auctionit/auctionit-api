import ExcelJS from "exceljs";
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  EMD_BLOCK_STATUS_LABELS,
  EMD_FORFEITED_TYPE_LABEL,
  EMD_TYPE_LABELS,
  EmdErrorMessages,
  EMD_NARRATION_TEMPLATES,
  EmdValidationMessages,
} from "@auctionit/messages/emd";
import { db } from "../db/index.js";
import {
  auctions,
  bidders,
  EMD_TYPE_TXN_TYPE,
  emdRefunds,
  emdTransactions,
  paymentTypes,
  users,
  type EmdBlockStatus,
  type EmdRefundStatus,
  type EmdTxnType,
  type EmdType,
} from "../db/schema/index.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import { EmdError } from "../lib/emd/errors.js";
import { refreshBalanceCachesSql } from "../lib/emd/blocked.js";
import { renderNarration, type NarrationValues } from "../lib/emd/render-narration.js";
import { clampPagination } from "./list-query.js";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

export type EmdPostInput = {
  bidderId: number;
  emdType: EmdType;
  amount: number;
  auctionId?: number | null;
  emdRangeId?: number | null;
  refundId?: number | null;
  forfeitureId?: number | null;
  transferId?: number | null;
  reversesTransactionId?: number | null;
  paymentTypeId?: number | null;
  bankTransactionId?: string | null;
  txnRefNo?: string | null;
  bankDescription?: string | null;
  valueDate?: string | null;
  remitterName?: string | null;
  remitterAccount?: string | null;
  remitterIfsc?: string | null;
  importBatchId?: string | null;
  blockStatus?: EmdBlockStatus | null;
  winningLotIds?: number[] | null;
  blockLotIds?: number[] | null;
  reference?: string | null;
  remarks?: string | null;
  /** Extra template values (lots, wonLots, paymentMode, stage, …). */
  narrationValues?: NarrationValues;
  /** Pre-rendered narration; skips the template (seed, legacy remarks). */
  narration?: string | null;
  createdBy: number;
  createdAt?: string | null;
};

export type PostOptions = {
  /** Skip the "debit cannot exceed Available" guard (settlement pairs, seed). */
  allowOverdraw?: boolean;
  /** Skip the cache refresh; the caller refreshes once after a batch. */
  skipRefresh?: boolean;
};

/**
 * Forfeiture approval keeps the `blocked_winning` entry (balances depend on it)
 * and only rewrites its narration, so the forfeited state is looked up here.
 */
const FORFEITED_WINNING = sql<boolean>`(
  ${emdTransactions.emdType} = 'blocked_winning' AND EXISTS (
    SELECT 1 FROM emd_forfeitures f
    WHERE f.status = 'forfeited'
      AND f.bidder_id = ${emdTransactions.bidderId}
      AND f.auction_id = ${emdTransactions.auctionId}
      AND f.emd_range_id IS NOT DISTINCT FROM ${emdTransactions.emdRangeId}
  )
)`;

export type PassbookEntry = {
  id: number;
  bidderId: number;
  bidderName: string | null;
  bidderVan: string | null;
  emdType: EmdType;
  txnType: EmdTxnType;
  amount: number;
  credit: number;
  debit: number;
  /** Bidder's balance after this entry. */
  runningBalance: number | null;
  narration: string;
  remarks: string | null;
  auctionId: number | null;
  auctionNumber: string | null;
  /** Lot numbers: the won lots for Winning entries, else the bidder's mapped lots on the auction. */
  lots: string[];
  txnRefNo: string | null;
  valueDate: string | null;
  paymentMode: string | null;
  refundId: number | null;
  refundStatus: EmdRefundStatus | null;
  reversesTransactionId: number | null;
  isCorrected: boolean;
  /** `blocked_winning` entry taken by an approved forfeiture. */
  isForfeited: boolean;
  createdAt: string;
  createdByName: string | null;
};

export type PassbookListResult = {
  items: PassbookEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** Available balance of the bidder. */
  balance: number | null;
};

export class EmdTransactionsService {
  /** Locks bidder rows in id order so concurrent ledger writes never deadlock. */
  async lockBidders(tx: Tx, bidderIds: number[]): Promise<void> {
    const ids = [...new Set(bidderIds)].sort((a, b) => a - b);
    if (ids.length === 0) return;
    const rows = await tx.execute<{ id: number }>(sql`
      SELECT id FROM bidders
      WHERE id = ANY(${`{${ids.join(",")}}`}::int[])
      ORDER BY id
      FOR UPDATE
    `);
    if (rows.rows.length !== ids.length) {
      throw EmdError.notFound(EmdErrorMessages.BIDDER_NOT_FOUND);
    }
  }

  async availableBalance(executor: Executor, bidderId: number): Promise<number> {
    const [row] = await executor
      .select({
        balance: sql<string>`COALESCE(SUM(CASE WHEN ${emdTransactions.txnType} = 'credit' THEN ${emdTransactions.amount} ELSE -${emdTransactions.amount} END), 0)`,
      })
      .from(emdTransactions)
      .where(eq(emdTransactions.bidderId, bidderId));
    return toAmount(row?.balance);
  }

  async refreshBalances(executor: Executor, bidderIds: number[] | null): Promise<void> {
    if (bidderIds != null && bidderIds.length === 0) return;
    await executor.execute(refreshBalanceCachesSql(bidderIds));
  }

  private narrationFor(
    input: EmdPostInput,
    auctionNumbers: Map<number, string | null>,
  ): string {
    if (input.narration != null && input.narration.trim() !== "") {
      return input.narration.trim().slice(0, 500);
    }
    const values: NarrationValues = {
      remarks: input.remarks,
      utr: input.txnRefNo,
      refundId: input.refundId,
      reference: input.reference,
      reversedTransactionId: input.reversesTransactionId,
      remitterName: input.remitterName,
      blockType: input.blockStatus ? EMD_BLOCK_STATUS_LABELS[input.blockStatus] : null,
      auctionNo: input.auctionId != null ? auctionNumbers.get(input.auctionId) : null,
      ...input.narrationValues,
    };
    return renderNarration(EMD_NARRATION_TEMPLATES[input.emdType], values);
  }

  private async auctionNumbersFor(
    executor: Executor,
    inputs: EmdPostInput[],
  ): Promise<Map<number, string | null>> {
    const ids = [
      ...new Set(
        inputs
          .filter((i) => i.narration == null && i.auctionId != null)
          .map((i) => i.auctionId!),
      ),
    ];
    if (ids.length === 0) return new Map();
    const rows = await executor
      .select({ id: auctions.id, auctionNumber: auctions.auctionNumber })
      .from(auctions)
      .where(inArray(auctions.id, ids));
    return new Map(rows.map((r) => [r.id, r.auctionNumber]));
  }

  /**
   * Posts ledger entries inside an open transaction: locks the bidders, guards
   * debits against Available, renders narrations and refreshes the caches.
   */
  async postMany(tx: Tx, inputs: EmdPostInput[], options: PostOptions = {}): Promise<number[]> {
    if (inputs.length === 0) return [];
    for (const input of inputs) {
      if (!(input.amount > 0)) {
        throw EmdError.validation(EmdValidationMessages.AMOUNT_POSITIVE, "amount");
      }
    }
    const bidderIds = [...new Set(inputs.map((i) => i.bidderId))];
    await this.lockBidders(tx, bidderIds);

    if (!options.allowOverdraw) {
      const debitByBidder = new Map<number, number>();
      for (const input of inputs) {
        const sign = EMD_TYPE_TXN_TYPE[input.emdType] === "debit" ? 1 : -1;
        debitByBidder.set(
          input.bidderId,
          round2((debitByBidder.get(input.bidderId) ?? 0) + sign * input.amount),
        );
      }
      for (const [bidderId, netDebit] of debitByBidder) {
        if (netDebit <= 0) continue;
        const available = await this.availableBalance(tx, bidderId);
        if (round2(netDebit) > round2(available)) throw EmdError.insufficientBalance();
      }
    }

    const auctionNumbers = await this.auctionNumbersFor(tx, inputs);
    const rows = [];
    for (const input of inputs) {
      rows.push({
        bidderId: input.bidderId,
        emdType: input.emdType,
        txnType: EMD_TYPE_TXN_TYPE[input.emdType],
        amount: round2(input.amount).toFixed(2),
        auctionId: input.auctionId ?? null,
        emdRangeId: input.emdRangeId ?? null,
        refundId: input.refundId ?? null,
        forfeitureId: input.forfeitureId ?? null,
        transferId: input.transferId ?? null,
        reversesTransactionId: input.reversesTransactionId ?? null,
        paymentTypeId: input.paymentTypeId ?? null,
        bankTransactionId: input.bankTransactionId ?? null,
        txnRefNo: input.txnRefNo ?? null,
        bankDescription: input.bankDescription ?? null,
        valueDate: input.valueDate ?? null,
        remitterName: input.remitterName ?? null,
        remitterAccount: input.remitterAccount ?? null,
        remitterIfsc: input.remitterIfsc ?? null,
        importBatchId: input.importBatchId ?? null,
        blockStatus: input.blockStatus ?? null,
        winningLotIds: input.winningLotIds ?? null,
        blockLotIds: input.blockLotIds ?? null,
        reference: input.reference ?? null,
        narration: this.narrationFor(input, auctionNumbers),
        remarks: input.remarks?.trim() || null,
        createdBy: input.createdBy,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      });
    }
    const inserted = await tx
      .insert(emdTransactions)
      .values(rows)
      .returning({ id: emdTransactions.id });

    if (!options.skipRefresh) await this.refreshBalances(tx, bidderIds);
    return inserted.map((r) => r.id);
  }

  async post(tx: Tx, input: EmdPostInput, options: PostOptions = {}): Promise<number> {
    const [id] = await this.postMany(tx, [input], options);
    return id!;
  }

  /** Runs `fn` in a transaction (the usual entry point for a single write). */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(fn);
  }

  /** One bidder's passbook, newest first, with the running balance per entry. */
  async list(opts: { bidderId: number; page: number; pageSize: number; hideCorrectedBlocks?: boolean }): Promise<PassbookListResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const bidderFilter = eq(emdTransactions.bidderId, opts.bidderId);
    // A revised block leaves a superseded debit and its reversing credit. They
    // are equal and opposite, so hiding both keeps one block row per auction
    // without breaking the running balance; hiding only one would.
    // A close settlement moves each Winning amount the same way (a credit that
    // carries `winning_lot_ids`, then its `blocked_winning` debit), so that pair
    // is hidden too and only the real release of the non-winning part shows. A
    // forfeited range keeps its pair visible so the forfeiture shows.
    const correctedBlockFilter = opts.hideCorrectedBlocks
      ? sql`${emdTransactions.emdType} <> 'release_block_revised'
          AND NOT (${emdTransactions.emdType} = 'blocked_bidder_attached' AND EXISTS (
            SELECT 1 FROM emd_transactions r WHERE r.reverses_transaction_id = ${emdTransactions.id}
          ))
          AND NOT (
            NOT EXISTS (
              SELECT 1 FROM emd_forfeitures f
              WHERE f.status = 'forfeited'
                AND f.bidder_id = ${emdTransactions.bidderId}
                AND f.auction_id = ${emdTransactions.auctionId}
                AND f.emd_range_id IS NOT DISTINCT FROM ${emdTransactions.emdRangeId}
            )
            AND (
              (${emdTransactions.emdType} = 'release_auction_closed'
                AND COALESCE(cardinality(${emdTransactions.winningLotIds}), 0) > 0)
              OR (${emdTransactions.emdType} = 'blocked_winning' AND EXISTS (
                SELECT 1 FROM emd_transactions c
                WHERE c.bidder_id = ${emdTransactions.bidderId}
                  AND c.auction_id = ${emdTransactions.auctionId}
                  AND c.emd_type = 'release_auction_closed'
                  AND COALESCE(cardinality(c.winning_lot_ids), 0) > 0
                  AND c.emd_range_id IS NOT DISTINCT FROM ${emdTransactions.emdRangeId}
              ))
            )
          )`
      : sql`true`;
    const where = and(bidderFilter, correctedBlockFilter)!;

    const runningBalance = sql<string>`(
      SELECT SUM(CASE WHEN r.txn_type = 'credit' THEN r.amount ELSE -r.amount END)
      FROM emd_transactions r
      WHERE r.bidder_id = ${emdTransactions.bidderId}
        AND (r.created_at, r.id) <= (${emdTransactions.createdAt}, ${emdTransactions.id})
    )`;

    const [[countRow], rows, balance] = await Promise.all([
      db.select({ n: count() }).from(emdTransactions).where(where),
      db
        .select({
          id: emdTransactions.id,
          bidderId: emdTransactions.bidderId,
          bidderName: bidders.companyName,
          bidderVan: bidders.van,
          emdType: emdTransactions.emdType,
          txnType: emdTransactions.txnType,
          amount: emdTransactions.amount,
          narration: emdTransactions.narration,
          remarks: emdTransactions.remarks,
          auctionId: emdTransactions.auctionId,
          auctionNumber: auctions.auctionNumber,
          txnRefNo: emdTransactions.txnRefNo,
          reference: emdTransactions.reference,
          valueDate: emdTransactions.valueDate,
          paymentMode: paymentTypes.name,
          refundId: emdTransactions.refundId,
          refundStatus: emdRefunds.status,
          reversesTransactionId: emdTransactions.reversesTransactionId,
          createdAt: emdTransactions.createdAt,
          createdByName: users.name,
          runningBalance,
          isForfeited: FORFEITED_WINNING,
        })
        .from(emdTransactions)
        .leftJoin(bidders, eq(bidders.id, emdTransactions.bidderId))
        .leftJoin(auctions, eq(auctions.id, emdTransactions.auctionId))
        .leftJoin(paymentTypes, eq(paymentTypes.id, emdTransactions.paymentTypeId))
        .leftJoin(emdRefunds, eq(emdRefunds.id, emdTransactions.refundId))
        .leftJoin(users, eq(users.id, emdTransactions.createdBy))
        .where(where)
        .orderBy(desc(emdTransactions.createdAt), desc(emdTransactions.id))
        .limit(pageSize)
        .offset(offset),
      this.availableBalance(db, opts.bidderId),
    ]);

    const pageIds = rows.map((r) => r.id);
    const corrected = new Set<number>();
    const lotsById = new Map<number, string[]>();
    if (pageIds.length > 0) {
      const [links, lotRows] = await Promise.all([
        db
          .select({ id: emdTransactions.reversesTransactionId })
          .from(emdTransactions)
          .where(
            and(
              isNotNull(emdTransactions.reversesTransactionId),
              inArray(emdTransactions.reversesTransactionId, pageIds),
            ),
          ),
        this.lotsForEntries(pageIds),
      ]);
      for (const l of links) if (l.id != null) corrected.add(l.id);
      for (const r of lotRows) lotsById.set(r.id, r.lots);
    }

    return {
      items: rows.map((r) => {
        const amount = toAmount(r.amount);
        return {
          id: r.id,
          bidderId: r.bidderId,
          bidderName: r.bidderName,
          bidderVan: r.bidderVan,
          emdType: r.emdType,
          txnType: r.txnType,
          amount,
          credit: r.txnType === "credit" ? amount : 0,
          debit: r.txnType === "debit" ? amount : 0,
          runningBalance: r.runningBalance == null ? null : toAmount(r.runningBalance),
          narration: r.narration,
          remarks: r.remarks,
          auctionId: r.auctionId,
          auctionNumber: r.auctionNumber,
          lots: lotsById.get(r.id) ?? [],
          txnRefNo: r.txnRefNo ?? r.reference,
          valueDate: r.valueDate,
          paymentMode: r.paymentMode,
          refundId: r.refundId,
          refundStatus: r.refundStatus,
          reversesTransactionId: r.reversesTransactionId,
          isCorrected: corrected.has(r.id),
          isForfeited: r.isForfeited === true,
          createdAt: r.createdAt,
          createdByName: r.createdByName,
        };
      }),
      total: countRow?.n ?? 0,
      page,
      pageSize,
      balance,
    };
  }

  /**
   * Lot numbers per entry in display order. Winning entries carry their won
   * lots; block/release entries carry a point-in-time snapshot in
   * `block_lot_ids` once posted with one. Older rows written before that
   * column existed fall back to the bidder's current mapped lots on the
   * auction (an auction-level map covers every lot); inactive maps count
   * there, so releases after a detach still show their lots.
   */
  private async lotsForEntries(ids: number[]): Promise<{ id: number; lots: string[] }[]> {
    const rows = await db.execute<{ id: number; lots: string[] }>(sql`
      SELECT t.id,
             array_agg(COALESCE(NULLIF(l.lot_number, ''), '#' || l.id)
                       ORDER BY l.display_order NULLS LAST, l.id) AS lots
      FROM emd_transactions t
      JOIN auction_lots l
        ON CASE
             WHEN cardinality(t.winning_lot_ids) > 0 THEN l.id = ANY(t.winning_lot_ids)
             WHEN t.block_lot_ids IS NOT NULL THEN l.id = ANY(t.block_lot_ids)
             ELSE l.auction_id = t.auction_id AND l.is_active
                  AND EXISTS (
                    SELECT 1 FROM auction_lot_bidder_maps m
                    WHERE m.auction_id = t.auction_id AND m.bidder_id = t.bidder_id
                      AND (m.lot_id IS NULL OR m.lot_id = l.id)
                      AND COALESCE(m.is_emd_with_client, false) = false
                  )
                  AND NOT (t.emd_type = 'release_auction_closed' AND l.winner_bidder_id = t.bidder_id)
           END
      WHERE t.id = ANY(${`{${ids.join(",")}}`}::int[]) AND t.auction_id IS NOT NULL
      GROUP BY t.id
    `);
    return rows.rows;
  }

  /** All entries for one bidder as an XLSX workbook buffer, oldest last. */
  async passbookXlsx(bidderId: number): Promise<Buffer> {
    const where = eq(emdTransactions.bidderId, bidderId);

    const runningBalance = sql<string>`(
      SELECT SUM(CASE WHEN r.txn_type = 'credit' THEN r.amount ELSE -r.amount END)
      FROM emd_transactions r
      WHERE r.bidder_id = ${emdTransactions.bidderId}
        AND (r.created_at, r.id) <= (${emdTransactions.createdAt}, ${emdTransactions.id})
    )`;

    const rows = await db
      .select({
        id: emdTransactions.id,
        emdType: emdTransactions.emdType,
        txnType: emdTransactions.txnType,
        amount: emdTransactions.amount,
        narration: emdTransactions.narration,
        auctionId: emdTransactions.auctionId,
        auctionNumber: auctions.auctionNumber,
        createdAt: emdTransactions.createdAt,
        runningBalance,
        isForfeited: FORFEITED_WINNING,
      })
      .from(emdTransactions)
      .leftJoin(auctions, eq(auctions.id, emdTransactions.auctionId))
      .where(where)
      .orderBy(desc(emdTransactions.createdAt), desc(emdTransactions.id));

    const pageIds = rows.map((r) => r.id);
    const lotsById = new Map<number, string[]>();
    if (pageIds.length > 0) {
      const lotRows = await this.lotsForEntries(pageIds);
      for (const r of lotRows) lotsById.set(r.id, r.lots);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "AuctionIT Admin";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("EMD Passbook", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = [
      { header: "Date", key: "date", width: 14 },
      { header: "Type", key: "type", width: 30 },
      { header: "Narration", key: "narration", width: 50 },
      { header: "Auction Details", key: "auction", width: 24 },
      { header: "Lot(s)", key: "lots", width: 30 },
      { header: "Credit", key: "credit", width: 14 },
      { header: "Debit", key: "debit", width: 14 },
      { header: "Balance", key: "balance", width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const r of rows) {
      const amount = toAmount(r.amount);
      const credit = r.txnType === "credit" ? amount : 0;
      const debit = r.txnType === "debit" ? amount : 0;
      const balance = r.runningBalance == null ? "" : toAmount(r.runningBalance);
      const lots = lotsById.get(r.id) ?? [];
      const d = new Date(r.createdAt);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as const;
      const date = `${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      sheet.addRow({
        date,
        type: r.isForfeited ? EMD_FORFEITED_TYPE_LABEL : EMD_TYPE_LABELS[r.emdType],
        narration: r.narration,
        auction: r.auctionId != null ? (r.auctionNumber ?? `Auction #${r.auctionId}`) : "",
        lots: lots.join(", "),
        credit: credit || "",
        debit: debit || "",
        balance,
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async bidderOptions(): Promise<{ id: number; name: string; van: string | null }[]> {
    const rows = await db
      .select({ id: bidders.id, name: bidders.companyName, van: bidders.van })
      .from(bidders)
      .where(and(eq(bidders.isActive, true), eq(bidders.isVerified, true)))
      .orderBy(asc(bidders.companyName));
    return rows.map((r) => ({ id: r.id, name: `${r.name} (${r.id})`, van: r.van }));
  }
}

export const emdTransactionsService = new EmdTransactionsService();

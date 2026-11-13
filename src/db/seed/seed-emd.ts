import pg from "pg";
import {
  EMD_TYPE_LABELS,
  EMD_NARRATION_TEMPLATES,
  EMD_LEGACY_LOT_RELEASE_REMARKS,
} from "@auctionit/messages/emd";
import { env } from "../../env.js";
import {
  EMD_TYPE_TXN_TYPE,
  type EmdRefundStatus,
  type EmdType,
} from "../schema/index.js";
import { refreshBalanceCachesSql, blockedByAuctionSql } from "../../lib/emd/blocked.js";
import { renderNarration } from "../../lib/emd/render-narration.js";
import { round2, toAmount } from "../../lib/emd/constants.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { splitNullRangeHold } from "../../lib/emd/split-null-range-hold.js";
import { connectMssql } from "./mssql.js";
import {
  matchCancelCredits,
  matchRefundDebits,
  pairTransfers,
  TRANSFER_LOOSE_RE,
  type LegacyRefund,
  type LegacyRow,
} from "./emd-legacy-match.js";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * EMD seed orchestrator (plan 2.7): truncates the EMD tables and reloads them
 * from MSSQL in one transaction.
 *   1. PayEMD            → emd_refunds (status from Admin/Account codes)
 *   2. BidderPassBook    → emd_transactions (TrnId kept as id). Rows with no
 *      auction are linked by matching (emd-legacy-match.ts): refund debits →
 *      refund_requested / refund_processed with refund_id, cancel credits →
 *      refund_cancelled with refund_id, EMDTransfer pairs → transfer_out /
 *      transfer_in (legacy has no transfer log table to backfill emd_transfers
 *      from, so pairing only classifies the ledger rows). Other debits are
 *      refund_processed (payout remark) or correction_debit. Deposits get
 *      their EMD_Book payment mode.
 *   3. open refunds without a debit → synthetic refund_requested (expected 0)
 *   4. remaining blocks on closed auctions → range hold (stays blocked) / forfeiture / paused job
 *   5. EMDForFeited rows not covered by step 4 → emd_forfeitures
 *   6. payment account numbers, VAN, caches, sequences
 * Run `pnpm emd:verify-seed` afterwards.
 */

const CHUNK = 5000;
const ICICI_696_ACCOUNT = "025005500696";

/** Default forfeiture dispositions; existing rows (and admin edits) are kept. */
const FORFEITURE_DISPOSITIONS = [
  "Lifting not completed within window",
  "Sale value not paid",
  "Security deposit not paid",
  "Backed out after winning",
];
const DISPOSITION_LIFTING_NOT_DONE = 1;

const PASSBOOK_SQL = `
SELECT p.trnid AS trnId, p.BidderCompId AS bidderId, p.AuctionId AS auctionId,
       p.Remark AS remark, CONVERT(varchar(40), p.AmountCR) AS amountCr,
       CONVERT(varchar(40), p.AmountDR) AS amountDr, p.EMDProcessStatus AS emdProcessStatus,
       p.PayEMDId AS payEmdId, p.LotEmdId AS lotEmdId, p.TransactionID AS transactionId,
       CONVERT(varchar(33), p.TransactionDate, 126) AS transactionDate,
       CONVERT(varchar(33), p.CreatedOn, 126) AS createdAt, p.CreatedBY AS createdBy
FROM tbl_Data_BidderPassBook p
ORDER BY p.trnid`;

const PAYEMD_SQL = `
SELECT p.PayId AS id, p.BidderCompId AS bidderId, CONVERT(varchar(40), p.Amount) AS amount,
       p.TransactionId AS transactionId, CONVERT(varchar(33), p.trnDate, 126) AS trnDate,
       p.Remarks AS remarks, p.IsCancelRequest AS isCancelRequest,
       CAST(p.IsRequestFromAdmin AS int) AS isRequestFromAdmin, p.CreatedBy AS createdBy,
       CAST(p.AdminStatus AS int) AS adminStatus, CONVERT(varchar(33), p.AdminStatusDate, 126) AS adminStatusDate,
       CAST(p.AccountStatus AS int) AS accountStatus, CONVERT(varchar(33), p.AccountStatusDate, 126) AS accountStatusDate,
       CONVERT(varchar(33), p.CreatedOn, 126) AS createdAt,
       CONVERT(varchar(33), p.UpdatedOn, 126) AS updatedAt
FROM tbl_Data_PayEMD p
WHERE p.PayStatus = 1
ORDER BY p.PayId`;

const EMD_BOOK_SQL = `
SELECT b.BidderCompId AS bidderId, CONVERT(varchar(40), b.Amount) AS amount,
       b.TransactionID AS transactionId, b.PaymentType AS paymentType
FROM tbl_EMD_Book b
WHERE b.PaymentType IS NOT NULL AND b.Amount > 0`;

/** Legacy EMD deposits are almost all into this account (tbl_EMD_Book). */
const DEFAULT_DEPOSIT_PAYMENT_TYPE_ID = 1;

const FORFEITED_SQL = `
SELECT f.id, f.AuctionId AS auctionId, f.BidderCompId AS bidderId,
       CONVERT(varchar(40), f.Amount) AS amount, CAST(f.EMDStatus AS int) AS status, f.Remark AS remark,
       CONVERT(varchar(33), f.CreatedOn, 126) AS createdAt
FROM tbl_Data_EMDForFeited f
ORDER BY f.id`;

/** Lot-wise EMD unblock events (proc_EMDReport's `UnBlockEmdLot`), one per
 * (auction, bidder, range) release. Keyed only by range, not lot — step 4.5
 * resolves lots from `wonLots` + the range's display-order bounds. */
const EMD_RESERVED_LOG_SQL = `
SELECT l.Auctionid AS auctionId, l.BidderCompId AS bidderId, l.LotEmdId AS lotEmdId,
       CONVERT(varchar(40), l.Amount) AS amount,
       CONVERT(varchar(33), l.CreatedOn, 126) AS createdAt, l.CreatedBy AS createdBy
FROM tbl_Data_EMDReserved_log l
WHERE l.Remarks = 'Lot wise EMD unblock'
ORDER BY l.CreatedOn`;

type PassbookRow = {
  trnId: string | number;
  bidderId: string | number | null;
  auctionId: string | number | null;
  remark: string | null;
  amountCr: string | null;
  amountDr: string | null;
  emdProcessStatus: number | null;
  payEmdId: string | number | null;
  lotEmdId: string | number | null;
  transactionId: string | null;
  transactionDate: string | null;
  createdAt: string | null;
  createdBy: number | null;
};

type PayEmdRow = {
  id: string | number;
  bidderId: string | number | null;
  amount: string | null;
  transactionId: string | null;
  trnDate: string | null;
  remarks: string | null;
  isCancelRequest: number | null;
  isRequestFromAdmin: number | null;
  createdBy: number | null;
  adminStatus: number | null;
  adminStatusDate: string | null;
  accountStatus: number | null;
  accountStatusDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type EmdBookRow = {
  bidderId: string | number | null;
  amount: string | null;
  transactionId: string | null;
  paymentType: number | null;
};

type ForfeitedRow = {
  id: number;
  auctionId: number;
  bidderId: number;
  amount: string;
  status: number;
  remark: string | null;
  createdAt: string | null;
};

type EmdReservedLogRow = {
  auctionId: number | null;
  bidderId: number | null;
  lotEmdId: number | null;
  amount: string | null;
  createdAt: string | null;
  createdBy: number | null;
};

type TxnInsert = {
  id?: number;
  bidder_id: number;
  emd_type: EmdType;
  txn_type: string;
  amount: string;
  auction_id: number | null;
  emd_range_id?: number | null;
  refund_id: number | null;
  forfeiture_id?: number | null;
  transfer_id?: number | null;
  payment_type_id?: number | null;
  txn_ref_no: string | null;
  value_date: string | null;
  winning_lot_ids?: string | null;
  narration: string;
  remarks: string | null;
  created_at: string;
  created_by: number;
};

const report = {
  passbookRows: 0,
  ledgerRows: 0,
  skippedZero: 0,
  skippedMissingBidder: 0,
  missingBidderIds: new Set<number>(),
  auctionNulled: 0,
  auctionNulledAmount: 0,
  unclassified: 0,
  byType: new Map<EmdType, number>(),
  refunds: 0,
  refundsSkippedMissingBidder: 0,
  refundsByStatus: new Map<EmdRefundStatus, number>(),
  refundDebitsLinked: 0,
  refundsPaidLinked: 0,
  refundsPaid: 0,
  cancelCreditsLinked: 0,
  refundsCancelled: 0,
  unlinkedRefundPayouts: 0,
  correctionDebits: 0,
  transfers: 0,
  transferAmount: 0,
  transferLooseDebits: 0,
  transferLooseCredits: 0,
  transferUnmatchedDebits: [] as string[],
  transferUnmatchedCredits: [] as string[],
  emdBookTransferCredits: 0,
  transferInLegsWritten: 0,
  depositsTypedFromBook: 0,
  depositsTypedDefault: 0,
  depositsUntyped: 0,
  rangesLinked: 0,
  syntheticRefundDebits: 0,
  winningPairs: 0,
  winningAmount: 0,
  forfeitPairs: 0,
  forfeitAmount: 0,
  forfeitMismatch: [] as string[],
  forfeitsSkippedNoBlock: [] as string[],
  forfeitsRejected: 0,
  staleBlockPairs: 0,
  staleBlockAmount: 0,
  pausedJobs: 0,
  openAuctionBlockPairs: 0,
  nonClosedNonLiveBlockPairs: 0,
  settledAuctions: 0,
  lotReleaseLogRows: 0,
  lotReleaseSkippedNoBidderOrAuction: [] as string[],
  lotReleaseSkippedRangeMismatch: [] as string[],
  lotReleaseSkippedNoWonLots: [] as string[],
  lotReleaseSkippedAmbiguousCardinality: [] as string[],
  lotReleaseTxnMatched: 0,
  lotReleaseTxnUnmatched: [] as string[],
  lotReleaseDuplicateSkipped: [] as string[],
  lotReleasesWritten: 0,
};

function str(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function int(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

const CANCEL_CREDIT_RE = /^(cancel request by|refund cancell?ation)/i;
const OPENING_RE = /opening bal/i;
const DEPOSIT_RE = /^emd credited by/i;
const PAYOUT_RE = /return|refund/i;

/** Plan 2.7 step 1 type mapping, from side, auction and remark. */
function classify(
  side: "credit" | "debit",
  hasAuction: boolean,
  remark: string | null,
  transactionId: string | null,
): { type: EmdType; unclassified: boolean } {
  const r = remark ?? "";
  if (side === "debit") {
    if (hasAuction) return { type: "blocked_bidder_attached", unclassified: false };
    return { type: "refund_requested", unclassified: false };
  }
  if (hasAuction) return { type: "release_by_admin", unclassified: false };
  if (CANCEL_CREDIT_RE.test(r)) return { type: "refund_cancelled", unclassified: false };
  if (OPENING_RE.test(r)) return { type: "opening_balance", unclassified: false };
  if (transactionId || DEPOSIT_RE.test(r)) return { type: "emd_deposit", unclassified: false };
  return { type: "correction_credit", unclassified: true };
}

/**
 * Legacy refund screen codes → refund status (plan 2.7 step 2). Legacy on-hold
 * goes back to `requested`, payment-in-process stays `verified`.
 */
function refundStatus(r: PayEmdRow): EmdRefundStatus {
  const tx = str(r.transactionId);
  if (tx && tx.toLowerCase() === "cancel") return "cancelled";
  if (tx) return "paid";
  if (r.accountStatus === 3) return "paid";
  if (r.accountStatus === 1 || r.accountStatus === 2) return "verified";
  if (r.adminStatus === 2) return "reviewed";
  return "requested";
}

const OPEN_REFUND: EmdRefundStatus[] = ["requested", "reviewed", "verified"];

/** `YYYY-MM-DD` of an MSSQL ISO timestamp (local date as stored). */
function dateOnly(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

async function insertJson(client: pg.PoolClient, table: string, rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const cols = Object.keys(batch.reduce((acc, r) => Object.assign(acc, r), {}));
    await client.query(
      `INSERT INTO ${table} (${cols.join(", ")})
       SELECT ${cols.join(", ")} FROM json_populate_recordset(NULL::${table}, $1::json)`,
      [JSON.stringify(batch)],
    );
  }
}

function inc<K>(m: Map<K, number>, k: K, by = 1) {
  m.set(k, (m.get(k) ?? 0) + by);
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const dialect = new PgDialect();
  const client = await pgPool.connect();

  try {
    const [passbook, payEmd, forfeited, emdBook, reservedLog] = await Promise.all([
      mssqlPool.request().query<PassbookRow>(PASSBOOK_SQL),
      mssqlPool.request().query<PayEmdRow>(PAYEMD_SQL),
      mssqlPool.request().query<ForfeitedRow>(FORFEITED_SQL),
      mssqlPool.request().query<EmdBookRow>(EMD_BOOK_SQL),
      mssqlPool.request().query<EmdReservedLogRow>(EMD_RESERVED_LOG_SQL),
    ]);
    console.log(
      `Pulled ${passbook.recordset.length} passbook, ${payEmd.recordset.length} PayEMD, ${forfeited.recordset.length} forfeited, ${emdBook.recordset.length} EMD book, ${reservedLog.recordset.length} lot-wise unblock rows.`,
    );

    const bidderIds = new Set(
      (await client.query<{ id: number }>("SELECT id FROM bidders")).rows.map((r) => r.id),
    );
    const userIds = new Set(
      (await client.query<{ id: number }>("SELECT id FROM users")).rows.map((r) => r.id),
    );
    const auctionRows = (
      await client.query<{ id: number; status: string; auction_number: string | null }>(
        "SELECT auction_id AS id, status, auction_number FROM auctions",
      )
    ).rows;
    const auctionById = new Map(auctionRows.map((a) => [a.id, a]));
    const paymentTypeIds = new Set(
      (await client.query<{ id: number }>("SELECT id FROM payment_types")).rows.map((r) => r.id),
    );
    const rangeRows = (
      await client.query<{
        id: number;
        auction_id: number;
        display_order: number | null;
        emd_amount: string;
        lot_display_order_from: string;
        lot_display_order_to: string;
      }>(`
        SELECT id, auction_id, display_order, emd_amount::text,
               lot_display_order_from::text, lot_display_order_to::text
        FROM auction_lot_emd_ranges`)
    ).rows;
    const rangeAuction = new Map(rangeRows.map((r) => [r.id, r.auction_id]));
    const userOf = (raw: number | null | undefined) =>
      raw != null && userIds.has(raw) ? raw : SEED_DEFAULT_USER_ID;

    await client.query("BEGIN");
    await client.query(`
      TRUNCATE emd_transactions, emd_refunds, emd_forfeitures, emd_transfers,
               emd_range_holds, emd_winning_lot_releases,
               emd_settlement_jobs, emd_import_staging_sessions RESTART IDENTITY CASCADE
    `);
    await client.query("UPDATE auctions SET emd_settled_at = NULL WHERE emd_settled_at IS NOT NULL");
    for (const [i, label] of FORFEITURE_DISPOSITIONS.entries()) {
      await client.query(
        "INSERT INTO emd_forfeiture_dispositions (id, label) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [i + 1, label],
      );
    }
    await client.query(
      `SELECT setval(pg_get_serial_sequence('emd_forfeiture_dispositions', 'id'),
              (SELECT COALESCE(MAX(id), 0) + 1 FROM emd_forfeiture_dispositions), false)`,
    );

    // ---- Step 1: refunds (inserted first so ledger rows can reference them) ----
    const refundRows: object[] = [];
    const refundById = new Map<number, { bidderId: number; amount: number; status: EmdRefundStatus; createdAt: string }>();
    const legacyRefunds: LegacyRefund[] = [];
    for (const r of payEmd.recordset) {
      const id = Number(r.id);
      const bidderId = int(r.bidderId);
      const amount = round2(toAmount(r.amount));
      if (bidderId == null || !bidderIds.has(bidderId) || !(amount > 0)) {
        report.refundsSkippedMissingBidder++;
        continue;
      }
      const status = refundStatus(r);
      inc(report.refundsByStatus, status);
      if (status === "paid") report.refundsPaid++;
      if (status === "cancelled") report.refundsCancelled++;
      const createdAt = r.createdAt ?? new Date().toISOString();
      const tx = str(r.transactionId);
      const paid = status === "paid";
      const paidAt = paid ? (r.trnDate ?? r.accountStatusDate) : null;
      refundById.set(id, { bidderId, amount, status, createdAt });
      legacyRefunds.push({
        id,
        bidderId,
        amount,
        at: Date.parse(createdAt),
        paid,
        cancelled: status === "cancelled",
        utr: paid ? tx : null,
      });
      refundRows.push({
        id,
        bidder_id: bidderId,
        amount: amount.toFixed(2),
        status,
        requested_at: createdAt,
        // A bidder-raised request stores the bidder id in CreatedBy, not a user.
        requested_by: r.isRequestFromAdmin === 1 ? userOf(r.createdBy) : SEED_DEFAULT_USER_ID,
        requested_remarks: str(r.remarks)?.replace(/^You:-\s*/, "") || null,
        reviewed_at: r.adminStatus === 2 ? r.adminStatusDate : null,
        verified_at: (r.accountStatus ?? 0) >= 1 ? r.accountStatusDate : null,
        txn_ref_no: paid && tx ? tx.slice(0, 100) : null,
        payment_date: dateOnly(paidAt),
        paid_at: paidAt,
        cancelled_at: status === "cancelled" ? (r.trnDate ?? r.updatedAt) : null,
        updated_at: r.updatedAt,
      });
    }
    await insertJson(client, "emd_refunds", refundRows);
    report.refunds = refundRows.length;

    // ---- Step 2a: link rows with no auction to refunds and transfers ----
    const looseDebits: LegacyRow[] = [];
    const looseCredits: LegacyRow[] = [];
    for (const r of passbook.recordset) {
      const bidderId = int(r.bidderId);
      if (bidderId == null || !bidderIds.has(bidderId) || int(r.auctionId) != null) continue;
      const cr = toAmount(r.amountCr);
      const dr = toAmount(r.amountDr);
      const single = (cr > 0 && dr === 0) || (dr > 0 && cr === 0);
      if (!single) continue;
      const row: LegacyRow = {
        trnId: Number(r.trnId),
        bidderId,
        amount: round2(cr > 0 ? cr : dr),
        at: Date.parse(r.createdAt ?? r.transactionDate ?? ""),
        remark: r.remark ?? "",
        payEmdId: int(r.payEmdId),
        processStatus: r.emdProcessStatus,
      };
      if (!Number.isFinite(row.at)) continue;
      (cr > 0 ? looseCredits : looseDebits).push(row);
    }
    const refundOfDebit = matchRefundDebits(legacyRefunds, looseDebits);
    const refundOfCredit = matchCancelCredits(
      legacyRefunds,
      looseCredits.filter((c) => CANCEL_CREDIT_RE.test(c.remark.trim())),
    );
    const transferPairs = pairTransfers(
      looseDebits.filter((d) => !refundOfDebit.has(d.trnId)),
      looseCredits,
    ).filter((t) => bidderIds.has(t.toBidderId) && t.toBidderId !== t.fromBidderId);

    // Completeness check (no algorithm change): did pairTransfers() consume
    // every transfer-shaped loose row? TRANSFER_LOOSE_RE is intentionally
    // broader than the strict patterns used for matching, so a format drift
    // in future legacy data shows up here instead of silently dropping a
    // transfer. Deliberately excludes "EMD transfer(red) to <client>" rows
    // (a different legacy concept, EMD paid to an external seller, not
    // another bidder) — see TRANSFER_LOOSE_RE's own doc comment.
    const pairedDebitIds = new Set(transferPairs.map((t) => t.debitTrnId));
    const pairedCreditIds = new Set(transferPairs.map((t) => t.creditTrnId));
    for (const d of looseDebits) {
      if (!TRANSFER_LOOSE_RE.test(d.remark.trim())) continue;
      report.transferLooseDebits++;
      if (!pairedDebitIds.has(d.trnId)) {
        report.transferUnmatchedDebits.push(`${d.trnId}: ${d.remark.trim()}`);
      }
    }
    for (const c of looseCredits) {
      if (!TRANSFER_LOOSE_RE.test(c.remark.trim())) continue;
      report.transferLooseCredits++;
      if (!pairedCreditIds.has(c.trnId)) {
        report.transferUnmatchedCredits.push(`${c.trnId}: ${c.remark.trim()}`);
      }
    }

    // No legacy source table for transfers exists (see header comment), so
    // pairing only classifies the matched ledger rows below; emd_transfers is
    // left for the live transfer request/approval workflow going forward.
    const transferTrnIds = new Set<number>();
    for (const t of transferPairs) {
      transferTrnIds.add(t.debitTrnId);
      transferTrnIds.add(t.creditTrnId);
      report.transfers++;
      report.transferAmount += t.amount;
    }

    // Free cross-check, no new SQL: tbl_EMD_Book's credit-side transfer rows
    // (visible here only because EMD_BOOK_SQL's `Amount > 0` filter happens to
    // keep them) vs the transfer_in legs actually written below. One-sided
    // signal only (no debit-side visibility under that filter) but costs
    // nothing extra to compute; a mismatch means pairTransfers()/the bidder
    // filters dropped something the legacy book still has.
    report.emdBookTransferCredits = emdBook.recordset.filter((b) =>
      TRANSFER_LOOSE_RE.test(str(b.transactionId)?.trim() ?? ""),
    ).length;

    // Deposit payment mode from the EMD book (bidder + amount + UTR).
    const bookType = new Map<string, number>();
    for (const b of emdBook.recordset) {
      const tx = str(b.transactionId);
      const bidderId = int(b.bidderId);
      if (!tx || bidderId == null || b.paymentType == null) continue;
      bookType.set(`${bidderId}:${round2(toAmount(b.amount)).toFixed(2)}:${tx.toUpperCase()}`, b.paymentType);
    }
    const depositPaymentType = (bidderId: number, amount: number, tx: string | null): number | null => {
      if (!tx) {
        report.depositsUntyped++;
        return null;
      }
      const fromBook = bookType.get(`${bidderId}:${round2(amount).toFixed(2)}:${tx.toUpperCase()}`);
      if (fromBook != null && paymentTypeIds.has(fromBook)) {
        report.depositsTypedFromBook++;
        return fromBook;
      }
      if (!paymentTypeIds.has(DEFAULT_DEPOSIT_PAYMENT_TYPE_ID)) {
        report.depositsUntyped++;
        return null;
      }
      report.depositsTypedDefault++;
      return DEFAULT_DEPOSIT_PAYMENT_TYPE_ID;
    };

    // ---- Step 2b: passbook → ledger ----
    const txns: TxnInsert[] = [];
    const refundsWithDebit = new Set<number>();
    for (const r of passbook.recordset) {
      report.passbookRows++;
      const cr = toAmount(r.amountCr);
      const dr = toAmount(r.amountDr);
      const bidderId = int(r.bidderId);
      if (bidderId == null || !bidderIds.has(bidderId)) {
        report.skippedMissingBidder++;
        if (bidderId != null) report.missingBidderIds.add(bidderId);
        continue;
      }
      const sides: { side: "credit" | "debit"; amount: number }[] = [];
      for (const [side, raw] of [["credit", cr], ["debit", dr]] as const) {
        if (raw > 0) sides.push({ side, amount: raw });
        else if (raw < 0) sides.push({ side: side === "credit" ? "debit" : "credit", amount: -raw });
      }
      if (sides.length === 0) {
        report.skippedZero++;
        continue;
      }
      let auctionId = int(r.auctionId);
      if (auctionId != null && !auctionById.has(auctionId)) {
        report.auctionNulled++;
        report.auctionNulledAmount += cr + dr;
        auctionId = null;
      }
      const remark = str(r.remark);
      const txnId = str(r.transactionId);
      const trnId = Number(r.trnId);
      const lotEmdId = int(r.lotEmdId);
      const emdRangeId =
        auctionId != null && lotEmdId != null && rangeAuction.get(lotEmdId) === auctionId ? lotEmdId : null;
      if (emdRangeId != null) report.rangesLinked++;
      sides.forEach(({ side, amount }, i) => {
        let { type, unclassified } = classify(side, int(r.auctionId) != null, remark, txnId);
        let refundId: number | null = null;
        // Matches are made on single-sided rows only, so they apply to side 0.
        const isTransfer = i === 0 && transferTrnIds.has(trnId);
        if (i === 0 && refundOfDebit.has(trnId)) {
          refundId = refundOfDebit.get(trnId)!;
          const paid = refundById.get(refundId)?.status === "paid";
          type = paid ? "refund_processed" : "refund_requested";
          refundsWithDebit.add(refundId);
          report.refundDebitsLinked++;
          if (paid) report.refundsPaidLinked++;
        } else if (i === 0 && refundOfCredit.has(trnId)) {
          refundId = refundOfCredit.get(trnId)!;
          type = "refund_cancelled";
          report.cancelCreditsLinked++;
        } else if (isTransfer) {
          type = side === "debit" ? "transfer_out" : "transfer_in";
          unclassified = false;
        } else if (type === "refund_requested") {
          // A debit with no auction that no refund request accounts for.
          if (remark && PAYOUT_RE.test(remark)) {
            type = "refund_processed";
            report.unlinkedRefundPayouts++;
          } else {
            type = "correction_debit";
            report.correctionDebits++;
          }
        }
        if (unclassified) report.unclassified++;
        inc(report.byType, type);
        txns.push({
          ...(i === 0 ? { id: Number(r.trnId) } : {}),
          bidder_id: bidderId,
          emd_type: type,
          txn_type: EMD_TYPE_TXN_TYPE[type],
          amount: round2(amount).toFixed(2),
          auction_id: auctionId,
          emd_range_id: emdRangeId,
          refund_id: refundId,
          // No emd_transfers row exists for legacy data to link to; only live
          // app code populates this going forward.
          transfer_id: null,
          payment_type_id: type === "emd_deposit" ? depositPaymentType(bidderId, amount, txnId) : null,
          txn_ref_no: type === "emd_deposit" && txnId ? txnId.slice(0, 100) : null,
          value_date: type === "emd_deposit" ? r.transactionDate : null,
          narration: (remark ?? `${EMD_TYPE_LABELS[type]} #${r.trnId}`).slice(0, 500),
          remarks: null,
          created_at: r.createdAt ?? r.transactionDate ?? new Date().toISOString(),
          created_by: userOf(r.createdBy),
        });
      });
    }
    await insertJson(
      client,
      "emd_transactions",
      txns.filter((t) => t.id != null),
    );
    await client.query(
      "SELECT setval(pg_get_serial_sequence('emd_transactions', 'id'), (SELECT COALESCE(MAX(id), 0) + 1 FROM emd_transactions), false)",
    );
    await insertJson(
      client,
      "emd_transactions",
      txns.filter((t) => t.id == null),
    );
    report.ledgerRows = txns.length;
    report.transferInLegsWritten = txns.filter((t) => t.emd_type === "transfer_in").length;

    // ---- Step 3: open refunds must already be debited ----
    const synthetic: TxnInsert[] = [];
    for (const [id, refund] of refundById) {
      if (!OPEN_REFUND.includes(refund.status) || refundsWithDebit.has(id)) continue;
      synthetic.push({
        bidder_id: refund.bidderId,
        emd_type: "refund_requested",
        txn_type: "debit",
        amount: refund.amount.toFixed(2),
        auction_id: null,
        refund_id: id,
        txn_ref_no: null,
        value_date: null,
        narration: renderNarration(EMD_NARRATION_TEMPLATES.refund_requested, { refundId: id }),
        remarks: null,
        created_at: refund.createdAt,
        created_by: SEED_DEFAULT_USER_ID,
      });
    }
    await insertJson(client, "emd_transactions", synthetic);
    report.syntheticRefundDebits = synthetic.length;

    // ---- Step 4: remaining blocks → range hold / forfeiture / paused job ----
    const blockedQuery = dialect.sqlToQuery(blockedByAuctionSql(null));
    const blockedPairs = (
      await client.query<{ bidder_id: number; auction_id: number; blocked: string }>(
        `SELECT * FROM (${blockedQuery.sql}) q WHERE q.blocked > 0`,
        blockedQuery.params,
      )
    ).rows;
    const wonRows = (
      await client.query<{
        auction_id: number;
        winner_bidder_id: number;
        ids: number[];
        orders: (string | null)[];
        labels: string[];
      }>(`
        SELECT auction_id, winner_bidder_id,
               array_agg(id ORDER BY display_order NULLS LAST, id) AS ids,
               array_agg(display_order::text ORDER BY display_order NULLS LAST, id) AS orders,
               array_agg(COALESCE(lot_number, id::text) ORDER BY display_order NULLS LAST, id) AS labels
        FROM auction_lots WHERE winner_bidder_id IS NOT NULL AND is_active
        GROUP BY auction_id, winner_bidder_id
      `)
    ).rows;
    const wonLots = new Map(wonRows.map((w) => [`${w.auction_id}:${w.winner_bidder_id}`, w]));
    const rangesByAuction = new Map<number, typeof rangeRows>();
    for (const r of rangeRows) {
      const list = rangesByAuction.get(r.auction_id) ?? [];
      list.push(r);
      rangesByAuction.set(r.auction_id, list);
    }
    const forfeitByPair = new Map<string, ForfeitedRow>();
    for (const f of forfeited.recordset) forfeitByPair.set(`${f.auctionId}:${f.bidderId}`, f);

    const holdRows: object[] = [];
    const forfeitRows: object[] = [];
    const handledForfeits = new Set<number>();
    const pausedAuctions = new Set<number>();
    const now = new Date().toISOString();
    for (const p of blockedPairs) {
      const auction = auctionById.get(p.auction_id);
      const amount = round2(toAmount(p.blocked));
      if (!auction) continue;
      if (auction.status !== "closed") {
        if (auction.status === "published") report.openAuctionBlockPairs++;
        else report.nonClosedNonLiveBlockPairs++;
        continue;
      }
      const key = `${p.auction_id}:${p.bidder_id}`;
      const forfeit = forfeitByPair.get(key);
      const lots = wonLots.get(key) ?? null;
      const takenForfeit = forfeit && (forfeit.status === 3 || forfeit.status === 2);
      if (!takenForfeit && !lots) {
        pausedAuctions.add(p.auction_id);
        report.staleBlockPairs++;
        report.staleBlockAmount += amount;
        continue;
      }
      // The money stays blocked: a range hold records what it covers, and a
      // taken forfeiture is held as forfeited.
      // Won lots in several EMD ranges are split per range, as a close does
      // today, so a lifting release can credit one range on its own. A hold
      // that cannot be split safely (forfeited, no ranges, lot outside every
      // range, ranges not adding up to the block) stays one range-less row.
      const perRange =
        lots && !takenForfeit
          ? splitNullRangeHold({
              amountHeld: amount,
              amountReleased: 0,
              amountForfeited: 0,
              ranges: (rangesByAuction.get(p.auction_id) ?? []).map((r) => ({
                id: r.id,
                displayOrder: r.display_order,
                emdAmount: toAmount(r.emd_amount),
                lotDisplayOrderFrom: toAmount(r.lot_display_order_from),
                lotDisplayOrderTo: toAmount(r.lot_display_order_to),
              })),
              wonLots: lots.ids.map((lotId, i) => ({
                lotId,
                displayOrder: lots.orders[i] == null ? null : toAmount(lots.orders[i]),
              })),
            })
          : null;
      const holdTargets = perRange ?? [
        { emdRangeId: null, amount, lotIds: lots?.ids ?? [] },
      ];
      for (const t of holdTargets) {
        holdRows.push({
          auction_id: p.auction_id,
          bidder_id: p.bidder_id,
          emd_range_id: t.emdRangeId,
          amount_held: t.amount.toFixed(2),
          amount_released: "0",
          amount_forfeited: takenForfeit ? t.amount.toFixed(2) : "0",
          lot_ids: `{${t.lotIds.join(",")}}`,
          created_at: now,
          updated_at: now,
        });
      }
      if (takenForfeit) {
        handledForfeits.add(forfeit.id);
        report.forfeitPairs++;
        report.forfeitAmount += amount;
        if (round2(toAmount(forfeit.amount)) !== amount) {
          report.forfeitMismatch.push(`${key} legacy=${forfeit.amount} ledger=${amount}`);
        }
        forfeitRows.push(forfeitureRow(forfeit, amount));
      } else {
        report.winningPairs++;
        report.winningAmount += amount;
      }
    }
    await insertJson(client, "emd_range_holds", holdRows);

    // ---- Step 4.5: legacy lot-wise EMD unblock → emd_winning_lot_releases ----
    // tbl_Data_EMDReserved_log only stores the range (LotEmdId), never a lot id,
    // and it's unclear whether one event releases a whole range at once or one
    // lot's share at a time. Group by (auction, bidder, range) and disambiguate
    // by cardinality + amount so either reading is handled, rather than assumed.
    const releaseTxnBySig = new Map<string, number[]>();
    for (const t of txns) {
      if (t.emd_type !== "release_by_admin" || t.emd_range_id == null || t.id == null) continue;
      const key = `${t.auction_id}:${t.bidder_id}:${t.emd_range_id}:${t.amount}`;
      const bucket = releaseTxnBySig.get(key);
      if (bucket) bucket.push(t.id);
      else releaseTxnBySig.set(key, [t.id]);
    }

    const rangeById = new Map(rangeRows.map((r) => [r.id, r]));
    const logGroups = new Map<string, EmdReservedLogRow[]>();
    for (const lg of reservedLog.recordset) {
      const auctionId = int(lg.auctionId);
      const bidderId = int(lg.bidderId);
      const lotEmdId = int(lg.lotEmdId);
      if (auctionId == null || bidderId == null || lotEmdId == null) continue;
      if (!bidderIds.has(bidderId) || !auctionById.has(auctionId)) {
        report.lotReleaseSkippedNoBidderOrAuction.push(`${auctionId}:${bidderId}:${lotEmdId}`);
        continue;
      }
      if (rangeAuction.get(lotEmdId) !== auctionId) {
        report.lotReleaseSkippedRangeMismatch.push(`${auctionId}:${bidderId}:${lotEmdId}`);
        continue;
      }
      const key = `${auctionId}:${bidderId}:${lotEmdId}`;
      const bucket = logGroups.get(key);
      if (bucket) bucket.push(lg);
      else logGroups.set(key, [lg]);
    }
    report.lotReleaseLogRows = reservedLog.recordset.length;

    const releaseRows: object[] = [];
    const seenBidderLot = new Set<string>();
    for (const [key, group] of logGroups) {
      const [auctionIdStr, bidderIdStr, lotEmdIdStr] = key.split(":");
      const auctionId = Number(auctionIdStr);
      const bidderId = Number(bidderIdStr);
      const lotEmdId = Number(lotEmdIdStr);
      const range = rangeById.get(lotEmdId);
      const won = wonLots.get(`${auctionId}:${bidderId}`);
      const rangeFrom = range ? toAmount(range.lot_display_order_from) : null;
      const rangeTo = range ? toAmount(range.lot_display_order_to) : null;
      const candidateLots = (won && range
        ? won.ids
            .map((id, i) => ({
              id,
              order: won.orders[i] == null ? null : toAmount(won.orders[i]!),
            }))
            .filter((l) => l.order != null && l.order >= rangeFrom! && l.order <= rangeTo!)
            .sort((a, b) => a.order! - b.order!)
        : []
      );
      if (candidateLots.length === 0) {
        report.lotReleaseSkippedNoWonLots.push(key);
        continue;
      }

      const sortedGroup = [...group].sort(
        (a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""),
      );
      const rangeAmount = toAmount(range!.emd_amount);
      const expectedShare = round2(rangeAmount / candidateLots.length);

      let assignment: { lg: EmdReservedLogRow; lots: number[] }[];
      if (sortedGroup.length === 1) {
        const amt = round2(toAmount(sortedGroup[0]!.amount));
        if (
          candidateLots.length > 1 &&
          Math.abs(amt - expectedShare) < 0.01 &&
          Math.abs(amt - rangeAmount) > 0.01
        ) {
          // A single per-lot-share event in a multi-lot range: can't tell which lot.
          report.lotReleaseSkippedAmbiguousCardinality.push(`${key} amount=${amt}`);
          continue;
        }
        assignment = [{ lg: sortedGroup[0]!, lots: candidateLots.map((l) => l.id) }];
      } else if (sortedGroup.length <= candidateLots.length) {
        // One event per lot, in order; leftover lots were released some other
        // way (e.g. the out-of-scope whole-row UnBlockEmd path) — not an error.
        assignment = sortedGroup.map((lg, i) => ({ lg, lots: [candidateLots[i]!.id] }));
      } else {
        report.lotReleaseSkippedAmbiguousCardinality.push(
          `${key} events=${sortedGroup.length} lots=${candidateLots.length}`,
        );
        continue;
      }

      for (const { lg, lots } of assignment) {
        const amtKey = round2(toAmount(lg.amount)).toFixed(2);
        const sig = `${auctionId}:${bidderId}:${lotEmdId}:${amtKey}`;
        const pool = releaseTxnBySig.get(sig);
        const transactionId = pool?.shift();
        if (transactionId == null) {
          report.lotReleaseTxnUnmatched.push(sig);
          continue;
        }
        report.lotReleaseTxnMatched++;
        for (const lotId of lots) {
          const pairKey = `${bidderId}:${lotId}`;
          if (seenBidderLot.has(pairKey)) {
            report.lotReleaseDuplicateSkipped.push(pairKey);
            continue;
          }
          seenBidderLot.add(pairKey);
          releaseRows.push({
            auction_id: auctionId,
            bidder_id: bidderId,
            lot_id: lotId,
            emd_range_id: lotEmdId,
            remarks: EMD_LEGACY_LOT_RELEASE_REMARKS,
            transaction_id: transactionId,
            created_at: lg.createdAt ?? now,
            created_by: userOf(int(lg.createdBy)),
          });
        }
      }
    }
    await insertJson(client, "emd_winning_lot_releases", releaseRows);
    report.lotReleasesWritten = releaseRows.length;

    // ---- Step 5: forfeitures not covered by step 4 ----
    for (const f of forfeited.recordset) {
      if (handledForfeits.has(f.id)) continue;
      const auction = auctionById.get(f.auctionId);
      if (!auction || !bidderIds.has(f.bidderId)) {
        report.forfeitsSkippedNoBlock.push(`${f.auctionId}:${f.bidderId} (missing auction/bidder)`);
        continue;
      }
      if (f.status === 1) {
        forfeitRows.push(forfeitureRow(f, round2(toAmount(f.amount)), "rejected"));
        report.forfeitsRejected++;
        continue;
      }
      report.forfeitsSkippedNoBlock.push(`${f.auctionId}:${f.bidderId} amount=${f.amount}`);
    }
    await insertJson(client, "emd_forfeitures", forfeitRows);

    for (const auctionId of pausedAuctions) {
      await client.query(
        `INSERT INTO emd_settlement_jobs (auction_id, kind, status) VALUES ($1, 'legacy_cutover', 'paused')`,
        [auctionId],
      );
    }
    report.pausedJobs = pausedAuctions.size;

    // ---- Step 6: payment account, VAN, caches, sequences ----
    await client.query(
      "UPDATE payment_types SET account_number = $1 WHERE name = 'ICICI 696' AND account_number IS DISTINCT FROM $1",
      [ICICI_696_ACCOUNT],
    );
    await client.query("UPDATE bidders SET van = 'ICOM' || id WHERE van IS NULL");
    const pausedList = [...pausedAuctions];
    const settled = await client.query(
      `UPDATE auctions SET emd_settled_at = COALESCE(closed_at, now())
       WHERE status = 'closed' AND NOT (auction_id = ANY($1::int[]))`,
      [pausedList],
    );
    report.settledAuctions = settled.rowCount ?? 0;

    const refresh = dialect.sqlToQuery(refreshBalanceCachesSql(null));
    await client.query(refresh.sql, refresh.params);
    for (const table of ["emd_transactions", "emd_refunds", "emd_forfeitures"]) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 0) + 1 FROM ${table}), false)`,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await mssqlPool.close();
    await pgPool.end();
  }

  printReport(Date.now() - started);
}

function forfeitureRow(
  f: ForfeitedRow,
  amount: number,
  statusOverride?: "rejected",
) {
  const status = statusOverride ?? "forfeited";
  const paid = status === "forfeited" && f.status === 2;
  const remark = str(f.remark);
  const at = f.createdAt ?? new Date().toISOString();
  return {
    id: f.id,
    auction_id: f.auctionId,
    bidder_id: f.bidderId,
    emd_range_id: null,
    amount: amount.toFixed(2),
    disposition_id: remark && /lift/i.test(remark) ? DISPOSITION_LIFTING_NOT_DONE : null,
    requested_remarks: remark?.slice(0, 500) ?? null,
    status,
    requested_by: SEED_DEFAULT_USER_ID,
    requested_at: at,
    reviewed_by: SEED_DEFAULT_USER_ID,
    reviewed_at: at,
    // Legacy has no transfer date or UTR; the forfeiture date stands in.
    paid_to_client_by: paid ? SEED_DEFAULT_USER_ID : null,
    paid_to_client_at: paid ? at : null,
  };
}

function printReport(ms: number) {
  const fmt = (n: number) => round2(n).toLocaleString("en-IN");
  console.log("\n==== EMD seed report ====");
  console.log(`Passbook rows read:            ${report.passbookRows}`);
  console.log(`Ledger rows written:           ${report.ledgerRows}`);
  console.log(`  skipped zero rows:           ${report.skippedZero}`);
  console.log(`  skipped missing bidder:      ${report.skippedMissingBidder} (${[...report.missingBidderIds].slice(0, 20).join(", ")})`);
  console.log(`  auction id nulled (missing): ${report.auctionNulled} (₹${fmt(report.auctionNulledAmount)})`);
  console.log(`  unclassified → correction:   ${report.unclassified}`);
  for (const [t, n] of [...report.byType].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(28)} ${n}`);
  }
  console.log(`Refunds written:               ${report.refunds} (skipped ${report.refundsSkippedMissingBidder})`);
  for (const [s, n] of report.refundsByStatus) console.log(`    ${s.padEnd(28)} ${n}`);
  console.log(`  refund debits linked:        ${report.refundDebitsLinked}`);
  console.log(`    paid refunds linked:       ${report.refundsPaidLinked} / ${report.refundsPaid}`);
  console.log(`    cancel credits linked:     ${report.cancelCreditsLinked} / ${report.refundsCancelled}`);
  console.log(`  unlinked payouts (processed):${report.unlinkedRefundPayouts}`);
  console.log(`  other debits → correction:   ${report.correctionDebits}`);
  console.log(`Transfers rebuilt:             ${report.transfers} (₹${fmt(report.transferAmount)})`);
  console.log(`  loose transfer-shaped rows:  ${report.transferLooseDebits} debit / ${report.transferLooseCredits} credit`);
  console.log(`  unmatched transfer debits:   ${report.transferUnmatchedDebits.length}`);
  for (const m of report.transferUnmatchedDebits.slice(0, 20)) console.log(`    ${m}`);
  console.log(`  unmatched transfer credits:  ${report.transferUnmatchedCredits.length}`);
  for (const m of report.transferUnmatchedCredits.slice(0, 20)) console.log(`    ${m}`);
  console.log(`  EMD book "From Buyer" rows:  ${report.emdBookTransferCredits} vs transfer_in legs written: ${report.transferInLegsWritten} (mismatch ${Math.abs(report.emdBookTransferCredits - report.transferInLegsWritten)}; one-sided signal, debit side invisible under EMD_BOOK_SQL's Amount > 0 filter)`);
  console.log(`Deposit payment mode:          ${report.depositsTypedFromBook} from EMD book, ${report.depositsTypedDefault} defaulted, ${report.depositsUntyped} none (no UTR)`);
  console.log(`Ledger rows linked to a range: ${report.rangesLinked}`);
  console.log(`  synthetic refund debits:     ${report.syntheticRefundDebits}`);
  console.log(`Held ranges (won):             ${report.winningPairs} (₹${fmt(report.winningAmount)})`);
  console.log(`Held ranges (forfeited):      ${report.forfeitPairs} (₹${fmt(report.forfeitAmount)})`);
  console.log(`  forfeit amount mismatches:   ${report.forfeitMismatch.length}`);
  for (const m of report.forfeitMismatch) console.log(`    ${m}`);
  console.log(`  rejected (released) forfeits:${report.forfeitsRejected}`);
  console.log(`  forfeits with no block left: ${report.forfeitsSkippedNoBlock.length}`);
  for (const m of report.forfeitsSkippedNoBlock) console.log(`    ${m}`);
  console.log(`Stale blocks (no winning lot): ${report.staleBlockPairs} (₹${fmt(report.staleBlockAmount)}) → ${report.pausedJobs} paused jobs`);
  console.log(`Blocks on live auctions:       ${report.openAuctionBlockPairs}`);
  console.log(`Blocks on draft/archived:      ${report.nonClosedNonLiveBlockPairs}`);
  console.log(`Closed auctions marked settled:${report.settledAuctions}`);
  console.log(`Legacy lot-wise releases read:  ${report.lotReleaseLogRows}`);
  console.log(`  skipped no bidder/auction:    ${report.lotReleaseSkippedNoBidderOrAuction.length}`);
  console.log(`  skipped range mismatch:       ${report.lotReleaseSkippedRangeMismatch.length}`);
  console.log(`  skipped no won lots:          ${report.lotReleaseSkippedNoWonLots.length}`);
  console.log(`  skipped ambiguous cardinality:${report.lotReleaseSkippedAmbiguousCardinality.length}`);
  for (const m of report.lotReleaseSkippedAmbiguousCardinality.slice(0, 20)) console.log(`    ${m}`);
  console.log(`  txn matched / unmatched:      ${report.lotReleaseTxnMatched} / ${report.lotReleaseTxnUnmatched.length}`);
  for (const m of report.lotReleaseTxnUnmatched.slice(0, 20)) console.log(`    ${m}`);
  console.log(`  duplicate (bidder,lot) skips: ${report.lotReleaseDuplicateSkipped.length}`);
  console.log(`Lot-wise releases written:      ${report.lotReleasesWritten}`);
  console.log(`Done in ${ms}ms. Next: pnpm emd:verify-seed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

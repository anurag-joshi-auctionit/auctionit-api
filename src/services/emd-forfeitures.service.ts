import { and, count, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatUtcNow } from "@auctionit/lib/date";
import {
  EMD_FORFEITED_NARRATION,
  EmdErrorMessages,
  EmdValidationMessages,
  type EmdForfeitureClientPayment,
  type EmdForfeitureView,
} from "@auctionit/messages/emd";
import { db } from "../db/index.js";
import {
  auctionLotEmdRanges,
  auctions,
  bidders,
  clients,
  emdForfeitureDispositions,
  emdForfeitures,
  emdTransactions,
  users,
  type EmdForfeitureStatus,
} from "../db/schema/index.js";
import { EMAIL_SOURCE_TYPE_EMD_FORFEITURE } from "../db/schema/notification-email-logs.js";
import { NOTIFICATION_TYPE_EMD_FORFEITED } from "../db/schema/notification-types.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import { EmdError } from "../lib/emd/errors.js";
import {
  buildEmdForfeitureEmailHtml,
  buildEmdForfeitureEmailSubject,
} from "../lib/emd/forfeiture-email-template.js";
import { holdsByRangeSql } from "../lib/emd/blocked.js";
import { renderNarration } from "../lib/emd/render-narration.js";
import { enqueueEmail } from "./email-dispatch.service.js";
import { emdTransactionsService, type Tx } from "./emd-transactions.service.js";
import { clampPagination, combineConditions } from "./list-query.js";

export type EmdForfeitureRow = {
  id: number;
  auctionId: number;
  auctionNumber: string | null;
  clientId: number;
  clientName: string | null;
  bidderId: number;
  bidderName: string | null;
  bidderVan: string | null;
  emdRangeId: number | null;
  lotsLabel: string | null;
  amount: number;
  dispositionId: number | null;
  dispositionLabel: string | null;
  requestedRemarks: string | null;
  status: EmdForfeitureStatus;
  clientPayment: EmdForfeitureClientPayment | null;
  requestedAt: string;
  requestedByName: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewedRemarks: string | null;
  clientTxnRefNo: string | null;
  paidToClientAt: string | null;
  paidToClientByName: string | null;
};

export type EmdForfeitureFilters = {
  bidderId?: number;
  clientIds?: number[];
  auctionIds?: number[];
  from?: string;
  to?: string;
};

export type EmdForfeitureListFilters = EmdForfeitureFilters & {
  view?: EmdForfeitureView;
  page: number;
  pageSize: number;
};

type CountAmount = { count: number; amount: number };

/** `forfeited` = `payable` + `paid`, all on the review date. */
export type EmdForfeitureSummary = Record<EmdForfeitureView, CountAmount>;

export type EmdForfeitureAuctionOption = { auctionId: number; auctionNumber: string | null };

export type EmdForfeitureCandidate = {
  auctionId: number;
  bidderId: number;
  bidderName: string | null;
  bidderVan: string | null;
  emdRangeId: number | null;
  lotsLabel: string | null;
  lotNumbers: string[] | null;
  /** EMD still blocked for the range. */
  blocked: number;
};

/**
 * On a `holdsByRangeSql` row `w`: EMD still held and no pending or forfeited
 * request. Only a rejected one frees the range, matching the
 * `emd_forfeitures_open_target_unique` index.
 */
const openCandidateSql = sql`w.held > 0 AND NOT EXISTS (
  SELECT 1 FROM emd_forfeitures f
  WHERE f.auction_id = w.auction_id AND f.bidder_id = w.bidder_id
    AND f.emd_range_id IS NOT DISTINCT FROM w.emd_range_id
    AND f.status <> 'rejected'
)`;

const requester = alias(users, "requester");
const reviewer = alias(users, "reviewer");
const payer = alias(users, "payer");

/** "Lots 1–6" from a range's display orders (trailing zeros trimmed). */
export const rangeLabelSql = sql<string | null>`CASE WHEN ${auctionLotEmdRanges.id} IS NULL THEN NULL
  WHEN ${auctionLotEmdRanges.lotDisplayOrderFrom} = ${auctionLotEmdRanges.lotDisplayOrderTo}
    THEN 'Lot ' || trim_scale(${auctionLotEmdRanges.lotDisplayOrderFrom})::text
  ELSE 'Lots ' || trim_scale(${auctionLotEmdRanges.lotDisplayOrderFrom})::text || '–' || trim_scale(${auctionLotEmdRanges.lotDisplayOrderTo})::text
  END`;

/** Request date as an IST calendar day; the date-range filter applies to it. */
const requestedDaySql = sql`(${emdForfeitures.requestedAt} AT TIME ZONE 'Asia/Kolkata')::date`;

/** Review date once decided, request date while pending. */
const periodDateSql = sql`COALESCE(${emdForfeitures.reviewedAt}, ${emdForfeitures.requestedAt})`;

/** Groups a (auction, bidder, range) triple into a single Map key. */
function heldKey(auctionId: number, bidderId: number, emdRangeId: number | null): string {
  return `${auctionId}:${bidderId}:${emdRangeId ?? "null"}`;
}

const VIEW_CONDITIONS: Record<EmdForfeitureView, SQL> = {
  requested: eq(emdForfeitures.status, "requested"),
  forfeited: eq(emdForfeitures.status, "forfeited"),
  payable: and(eq(emdForfeitures.status, "forfeited"), isNull(emdForfeitures.paidToClientAt))!,
  paid: and(eq(emdForfeitures.status, "forfeited"), isNotNull(emdForfeitures.paidToClientAt))!,
  rejected: eq(emdForfeitures.status, "rejected"),
};

export class EmdForfeituresService {
  private async lockMany(tx: Tx, ids: number[]) {
    const unique = [...new Set(ids)];
    const rows = await tx
      .select()
      .from(emdForfeitures)
      .where(inArray(emdForfeitures.id, unique))
      .orderBy(emdForfeitures.id)
      .for("update");
    if (rows.length !== unique.length) throw EmdError.notFound(EmdErrorMessages.FORFEITURE_NOT_FOUND);
    return rows;
  }

  /** EMD currently held for every (auction, bidder, range) in `targets`, in one query. */
  private async heldForMany(
    tx: Tx,
    targets: { auctionId: number; bidderId: number; emdRangeId: number | null }[],
  ): Promise<Map<string, number>> {
    const bidderIds = [...new Set(targets.map((t) => t.bidderId))];
    const result = await tx.execute<{
      auction_id: number;
      bidder_id: number;
      emd_range_id: number | null;
      held: string | null;
    }>(sql`
      SELECT w.auction_id, w.bidder_id, w.emd_range_id, SUM(w.held) AS held
      FROM (${holdsByRangeSql(bidderIds)}) w
      GROUP BY w.auction_id, w.bidder_id, w.emd_range_id
    `);
    const map = new Map<string, number>();
    for (const row of result.rows) {
      map.set(
        heldKey(row.auction_id, row.bidder_id, row.emd_range_id),
        round2(toAmount(row.held)),
      );
    }
    return map;
  }

  private filterConditions(f: EmdForfeitureFilters): (SQL | undefined)[] {
    return [
      f.bidderId != null ? eq(emdForfeitures.bidderId, f.bidderId) : undefined,
      f.clientIds?.length
        ? inArray(
            emdForfeitures.auctionId,
            db.select({ id: auctions.id }).from(auctions).where(inArray(auctions.clientId, f.clientIds)),
          )
        : undefined,
      f.auctionIds?.length ? inArray(emdForfeitures.auctionId, f.auctionIds) : undefined,
      f.from ? sql`${requestedDaySql} >= CAST(${f.from} AS date)` : undefined,
      f.to ? sql`${requestedDaySql} <= CAST(${f.to} AS date)` : undefined,
    ];
  }

  async list(filters: EmdForfeitureListFilters): Promise<{
    items: EmdForfeitureRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { page, pageSize, offset } = clampPagination(filters.page, filters.pageSize);
    const where = combineConditions([
      ...this.filterConditions(filters),
      filters.view ? VIEW_CONDITIONS[filters.view] : undefined,
    ]);
    const [[countRow], rows] = await Promise.all([
      db.select({ n: count() }).from(emdForfeitures).where(where),
      db
        .select({
          f: emdForfeitures,
          auctionNumber: auctions.auctionNumber,
          clientId: auctions.clientId,
          clientName: clients.companyName,
          bidderName: bidders.companyName,
          bidderVan: bidders.van,
          lotsLabel: rangeLabelSql,
          dispositionLabel: emdForfeitureDispositions.label,
          requestedByName: requester.name,
          reviewedByName: reviewer.name,
          paidToClientByName: payer.name,
        })
        .from(emdForfeitures)
        .innerJoin(auctions, eq(auctions.id, emdForfeitures.auctionId))
        .leftJoin(bidders, eq(bidders.id, emdForfeitures.bidderId))
        .leftJoin(clients, eq(clients.id, auctions.clientId))
        .leftJoin(auctionLotEmdRanges, eq(auctionLotEmdRanges.id, emdForfeitures.emdRangeId))
        .leftJoin(emdForfeitureDispositions, eq(emdForfeitureDispositions.id, emdForfeitures.dispositionId))
        .leftJoin(requester, eq(requester.id, emdForfeitures.requestedBy))
        .leftJoin(reviewer, eq(reviewer.id, emdForfeitures.reviewedBy))
        .leftJoin(payer, eq(payer.id, emdForfeitures.paidToClientBy))
        .where(where)
        .orderBy(desc(periodDateSql), desc(emdForfeitures.id))
        .limit(pageSize)
        .offset(offset),
    ]);
    return {
      items: rows.map(({ f, ...r }) => ({
        id: f.id,
        auctionId: f.auctionId,
        auctionNumber: r.auctionNumber,
        clientId: r.clientId,
        clientName: r.clientName,
        bidderId: f.bidderId,
        bidderName: r.bidderName,
        bidderVan: r.bidderVan,
        emdRangeId: f.emdRangeId,
        lotsLabel: r.lotsLabel,
        amount: toAmount(f.amount),
        dispositionId: f.dispositionId,
        dispositionLabel: r.dispositionLabel,
        requestedRemarks: f.requestedRemarks,
        status: f.status,
        clientPayment: f.status === "forfeited" ? (f.paidToClientAt ? "paid" : "payable") : null,
        requestedAt: f.requestedAt,
        requestedByName: r.requestedByName,
        reviewedAt: f.reviewedAt,
        reviewedByName: r.reviewedByName,
        reviewedRemarks: f.reviewedRemarks,
        clientTxnRefNo: f.clientTxnRefNo,
        paidToClientAt: f.paidToClientAt,
        paidToClientByName: r.paidToClientByName,
      })),
      total: countRow?.n ?? 0,
      page,
      pageSize,
    };
  }

  /** One pass over the filtered rows; every bucket follows the same period. */
  async summary(filters: EmdForfeitureFilters): Promise<EmdForfeitureSummary> {
    const bucket = (view: EmdForfeitureView) => ({
      n: sql<number>`COUNT(*) FILTER (WHERE ${VIEW_CONDITIONS[view]})`.mapWith(Number),
      amount: sql<string>`COALESCE(SUM(${emdForfeitures.amount}) FILTER (WHERE ${VIEW_CONDITIONS[view]}), 0)`,
    });
    const [row] = await db
      .select({
        requested: bucket("requested"),
        forfeited: bucket("forfeited"),
        payable: bucket("payable"),
        paid: bucket("paid"),
        rejected: bucket("rejected"),
      })
      .from(emdForfeitures)
      .where(combineConditions(this.filterConditions(filters)));
    const pick = (b: { n: number; amount: string } | undefined): CountAmount => ({
      count: b?.n ?? 0,
      amount: toAmount(b?.amount),
    });
    return {
      requested: pick(row?.requested),
      forfeited: pick(row?.forfeited),
      payable: pick(row?.payable),
      paid: pick(row?.paid),
      rejected: pick(row?.rejected),
    };
  }

  /** Auctions of the selected clients that have forfeitures in the period. */
  async auctionOptions(filters: {
    clientIds: number[];
    from?: string;
    to?: string;
  }): Promise<EmdForfeitureAuctionOption[]> {
    return db
      .selectDistinct({ auctionId: emdForfeitures.auctionId, auctionNumber: auctions.auctionNumber })
      .from(emdForfeitures)
      .innerJoin(auctions, eq(auctions.id, emdForfeitures.auctionId))
      .where(combineConditions(this.filterConditions(filters)))
      .orderBy(desc(emdForfeitures.auctionId));
  }

  /** Auctions of one client, closed in the period, with held EMD still open to forfeit. */
  async candidateAuctions(filters: {
    clientId: number;
    from?: string;
    to?: string;
  }): Promise<EmdForfeitureAuctionOption[]> {
    const result = await db.execute<{ auction_id: number; auction_number: string | null }>(sql`
      SELECT a.auction_id, a.auction_number
      FROM auctions a
      WHERE a.client_id = ${filters.clientId}
        ${filters.from ? sql`AND a.closed_at::date >= CAST(${filters.from} AS date)` : sql``}
        ${filters.to ? sql`AND a.closed_at::date <= CAST(${filters.to} AS date)` : sql``}
        AND EXISTS (
          SELECT 1 FROM (${holdsByRangeSql(null)}) w
          WHERE w.auction_id = a.auction_id AND ${openCandidateSql}
        )
      ORDER BY a.closed_at DESC NULLS LAST, a.auction_id DESC`);
    return result.rows.map((r) => ({ auctionId: r.auction_id, auctionNumber: r.auction_number }));
  }

  /** Held EMD of one auction that can be forfeited, one row per bidder range. */
  async candidates(filters: { auctionId: number }): Promise<EmdForfeitureCandidate[]> {
    const result = await db.execute<{
      bidder_id: number;
      bidder_name: string | null;
      bidder_van: string | null;
      emd_range_id: number | null;
      lots_label: string | null;
      lot_numbers: string[] | null;
      blocked: string;
    }>(sql`
      SELECT w.bidder_id, b.company_name AS bidder_name, b.van AS bidder_van,
             w.emd_range_id,
             CASE WHEN r.id IS NULL THEN NULL
               WHEN r.lot_display_order_from = r.lot_display_order_to
                 THEN 'Lot ' || trim_scale(r.lot_display_order_from)::text
               ELSE 'Lots ' || trim_scale(r.lot_display_order_from)::text || '–' || trim_scale(r.lot_display_order_to)::text
             END AS lots_label,
             (
               SELECT array_agg(al.lot_number ORDER BY al.display_order)
               FROM auction_lots al
               WHERE al.id = ANY(hd.lot_ids)
                 AND NOT EXISTS (
                   SELECT 1 FROM auction_lot_bidder_maps m
                   WHERE m.auction_id = hd.auction_id AND m.bidder_id = hd.bidder_id
                     AND m.lot_id = al.id AND COALESCE(m.is_emd_with_client, false) = true
                 )
             ) AS lot_numbers,
             w.held AS blocked
      FROM (${holdsByRangeSql(null)}) w
      JOIN emd_range_holds hd ON hd.auction_id = w.auction_id AND hd.bidder_id = w.bidder_id
        AND hd.emd_range_id IS NOT DISTINCT FROM w.emd_range_id
      JOIN bidders b ON b.id = w.bidder_id
      LEFT JOIN auction_lot_emd_ranges r ON r.id = w.emd_range_id
      WHERE w.auction_id = ${filters.auctionId} AND ${openCandidateSql}
      ORDER BY b.company_name, w.bidder_id, r.lot_display_order_from NULLS FIRST`);
    return result.rows.map((r) => ({
      auctionId: filters.auctionId,
      bidderId: r.bidder_id,
      bidderName: r.bidder_name,
      bidderVan: r.bidder_van,
      emdRangeId: r.emd_range_id,
      lotsLabel: r.lots_label,
      lotNumbers: r.lot_numbers,
      blocked: toAmount(r.blocked),
    }));
  }

  /**
   * Requests forfeiting the whole blocked amount of each range (all or
   * nothing); the HOD reviews them. Row problems come back together as
   * `items.<index>[.<field>]` field errors.
   */
  async request(input: {
    auctionId: number;
    items: {
      bidderId: number;
      emdRangeId: number | null;
      dispositionId: number;
      requestedRemarks: string;
    }[];
    userId: number;
  }): Promise<{ created: number }> {
    const keyOf = (i: { bidderId: number; emdRangeId: number | null }) => `${i.bidderId}:${i.emdRangeId ?? ""}`;
    const rowErrors: Record<string, string[]> = {};
    const addRowError = (index: number, message: string, field?: string) => {
      (rowErrors[field ? `items.${index}.${field}` : `items.${index}`] ??= []).push(message);
    };
    const throwIfRowErrors = () => {
      if (Object.keys(rowErrors).length > 0) {
        throw new EmdError("VALIDATION", EmdValidationMessages.VALIDATION_FAILED, rowErrors);
      }
    };

    const seen = new Set<string>();
    input.items.forEach((item, index) => {
      const key = keyOf(item);
      if (seen.has(key)) addRowError(index, EmdErrorMessages.FORFEITURE_DUPLICATE_ROWS);
      seen.add(key);
    });
    throwIfRowErrors();

    return emdTransactionsService.run(async (tx) => {
      const dispositionIds = [...new Set(input.items.map((i) => i.dispositionId))];
      const dispositions = await tx
        .select({ id: emdForfeitureDispositions.id, isActive: emdForfeitureDispositions.isActive })
        .from(emdForfeitureDispositions)
        .where(inArray(emdForfeitureDispositions.id, dispositionIds));
      const dispositionById = new Map(dispositions.map((d) => [d.id, d]));
      input.items.forEach((item, index) => {
        const disposition = dispositionById.get(item.dispositionId);
        if (!disposition) {
          addRowError(index, EmdErrorMessages.FORFEITURE_DISPOSITION_NOT_FOUND, "dispositionId");
        } else if (!disposition.isActive) {
          addRowError(index, EmdErrorMessages.FORFEITURE_DISPOSITION_INACTIVE, "dispositionId");
        }
      });

      const [auction] = await tx
        .select({ id: auctions.id })
        .from(auctions)
        .where(eq(auctions.id, input.auctionId))
        .limit(1);
      if (!auction) throw EmdError.notFound(EmdErrorMessages.AUCTION_NOT_FOUND);

      await emdTransactionsService.lockBidders(tx, [...new Set(input.items.map((i) => i.bidderId))]);
      const open = await tx
        .select({ bidderId: emdForfeitures.bidderId, emdRangeId: emdForfeitures.emdRangeId })
        .from(emdForfeitures)
        .where(
          and(
            eq(emdForfeitures.auctionId, input.auctionId),
            inArray(
              emdForfeitures.bidderId,
              input.items.map((i) => i.bidderId),
            ),
            ne(emdForfeitures.status, "rejected"),
          ),
        );
      const openKeys = new Set(open.map(keyOf));

      const now = formatUtcNow();
      const held = await this.heldForMany(
        tx,
        input.items.map((item) => ({
          auctionId: input.auctionId,
          bidderId: item.bidderId,
          emdRangeId: item.emdRangeId,
        })),
      );
      const values = [];
      for (const [index, item] of input.items.entries()) {
        if (openKeys.has(keyOf(item))) {
          addRowError(index, EmdErrorMessages.FORFEITURE_ALREADY_OPEN);
          continue;
        }
        const h = held.get(heldKey(input.auctionId, item.bidderId, item.emdRangeId)) ?? 0;
        if (h <= 0) {
          addRowError(index, EmdErrorMessages.FORFEITURE_NO_WINNING);
          continue;
        }
        values.push({
          auctionId: input.auctionId,
          bidderId: item.bidderId,
          emdRangeId: item.emdRangeId,
          amount: h.toFixed(2),
          dispositionId: item.dispositionId,
          requestedRemarks: item.requestedRemarks,
          status: "requested" as const,
          requestedBy: input.userId,
          requestedAt: now,
        });
      }
      throwIfRowErrors();
      await tx.insert(emdForfeitures).values(values);
      return { created: values.length };
    });
  }

  /**
   * HOD review of pending requests (all or nothing). Approval forfeits
   * immediately: the blocked balance drops by the amount (no new ledger entry,
   * as the money already left Available when it was blocked) and the bidder is
   * notified.
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
    const rows = await emdTransactionsService.run(async (tx) => {
      const locked = await this.lockMany(tx, input.ids);
      if (locked.some((r) => r.status !== "requested")) {
        throw EmdError.conflict(EmdErrorMessages.FORFEITURE_INVALID_STATUS);
      }
      if (input.approve) {
        const bidderIds = [...new Set(locked.map((r) => r.bidderId))];
        await emdTransactionsService.lockBidders(tx, bidderIds);
        const held = await this.heldForMany(tx, locked);
        for (const r of locked) {
          const h = held.get(heldKey(r.auctionId, r.bidderId, r.emdRangeId)) ?? 0;
          if (h < round2(toAmount(r.amount))) {
            throw EmdError.conflict(EmdErrorMessages.FORFEITURE_WINNING_CHANGED);
          }
        }
      }
      const now = formatUtcNow();
      await tx
        .update(emdForfeitures)
        .set({
          status: input.approve ? "forfeited" : "rejected",
          reviewedBy: input.userId,
          reviewedAt: now,
          reviewedRemarks: input.remarks,
          updatedAt: now,
          updatedBy: input.userId,
        })
        .where(inArray(emdForfeitures.id, locked.map((r) => r.id)));
      if (input.approve) {
        const forfeitedByKey = new Map<
          string,
          { auctionId: number; bidderId: number; emdRangeId: number | null; amt: number }
        >();
        for (const r of locked) {
          const key = heldKey(r.auctionId, r.bidderId, r.emdRangeId);
          const amt = round2(toAmount(r.amount));
          const existing = forfeitedByKey.get(key);
          if (existing) existing.amt += amt;
          else forfeitedByKey.set(key, { auctionId: r.auctionId, bidderId: r.bidderId, emdRangeId: r.emdRangeId, amt });
        }
        const values = [...forfeitedByKey.values()].map(
          (v) => sql`(${v.auctionId}, ${v.bidderId}, ${v.emdRangeId}::int, ${v.amt}::numeric)`,
        );
        await tx.execute(sql`
          UPDATE emd_range_holds h
          SET amount_forfeited = h.amount_forfeited + v.amt, updated_at = now()
          FROM (VALUES ${sql.join(values, sql`, `)}) AS v(auction_id, bidder_id, emd_range_id, amt)
          WHERE h.auction_id = v.auction_id
            AND h.bidder_id = v.bidder_id
            AND h.emd_range_id IS NOT DISTINCT FROM v.emd_range_id
        `);
        await this.markForfeitedNarration(tx, locked.map((r) => r.id));
        await emdTransactionsService.refreshBalances(tx, [...new Set(locked.map((r) => r.bidderId))]);
      }
      return locked;
    });
    if (input.approve) {
      await Promise.all(rows.map((r) => this.notifyBidder(r.id, input.userId)));
    }
    return { updated: rows.length };
  }

  /** Rewrites the narration of the legacy `blocked_winning` entries the forfeitures take. */
  private async markForfeitedNarration(tx: Tx, ids: number[]): Promise<void> {
    const rows = await tx
      .select({
        auctionId: emdForfeitures.auctionId,
        bidderId: emdForfeitures.bidderId,
        emdRangeId: emdForfeitures.emdRangeId,
        auctionNumber: auctions.auctionNumber,
        dispositionLabel: emdForfeitureDispositions.label,
        requestedRemarks: emdForfeitures.requestedRemarks,
      })
      .from(emdForfeitures)
      .innerJoin(auctions, eq(auctions.id, emdForfeitures.auctionId))
      .leftJoin(emdForfeitureDispositions, eq(emdForfeitureDispositions.id, emdForfeitures.dispositionId))
      .where(inArray(emdForfeitures.id, ids));
    if (rows.length === 0) return;
    const values = rows.map((r) => {
      const narration = renderNarration(EMD_FORFEITED_NARRATION, {
        auctionNo: r.auctionNumber ?? `#${r.auctionId}`,
        reason: r.dispositionLabel ?? r.requestedRemarks,
      });
      return sql`(${r.bidderId}, ${r.auctionId}, ${r.emdRangeId}::int, ${narration})`;
    });
    await tx.execute(sql`
      UPDATE emd_transactions t
      SET narration = v.narration
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(bidder_id, auction_id, emd_range_id, narration)
      WHERE t.bidder_id = v.bidder_id
        AND t.auction_id = v.auction_id
        AND t.emd_type = 'blocked_winning'
        AND t.emd_range_id IS NOT DISTINCT FROM v.emd_range_id
    `);
  }

  /** Records one transfer to the client covering the selected forfeited rows. */
  async payClient(input: { ids: number[]; txnRefNo: string; userId: number }): Promise<{ updated: number }> {
    return emdTransactionsService.run(async (tx) => {
      const locked = await this.lockMany(tx, input.ids);
      if (locked.some((r) => r.status !== "forfeited")) {
        throw EmdError.conflict(EmdErrorMessages.FORFEITURE_INVALID_STATUS);
      }
      if (locked.some((r) => r.paidToClientAt != null)) {
        throw EmdError.conflict(EmdErrorMessages.FORFEITURE_ALREADY_PAID);
      }
      const clientRows = await tx
        .selectDistinct({ clientId: auctions.clientId })
        .from(auctions)
        .where(inArray(auctions.id, [...new Set(locked.map((r) => r.auctionId))]));
      if (clientRows.length > 1) {
        throw EmdError.validation(EmdErrorMessages.FORFEITURE_PAY_MIXED_CLIENTS);
      }
      const now = formatUtcNow();
      await tx
        .update(emdForfeitures)
        .set({
          clientTxnRefNo: input.txnRefNo,
          paidToClientBy: input.userId,
          paidToClientAt: now,
          updatedAt: now,
          updatedBy: input.userId,
        })
        .where(inArray(emdForfeitures.id, locked.map((r) => r.id)));
      return { updated: locked.length };
    });
  }

  /** Queues the forfeiture email; a failure is logged and never undoes the decision. */
  private async notifyBidder(id: number, userId: number): Promise<void> {
    try {
      const [row] = await db
        .select({
          bidderName: bidders.companyName,
          auctionNumber: auctions.auctionNumber,
          auctionId: emdForfeitures.auctionId,
          amount: emdForfeitures.amount,
          dispositionLabel: emdForfeitureDispositions.label,
          requestedRemarks: emdForfeitures.requestedRemarks,
          lotsLabel: rangeLabelSql,
        })
        .from(emdForfeitures)
        .innerJoin(bidders, eq(bidders.id, emdForfeitures.bidderId))
        .innerJoin(auctions, eq(auctions.id, emdForfeitures.auctionId))
        .leftJoin(auctionLotEmdRanges, eq(auctionLotEmdRanges.id, emdForfeitures.emdRangeId))
        .leftJoin(emdForfeitureDispositions, eq(emdForfeitureDispositions.id, emdForfeitures.dispositionId))
        .where(eq(emdForfeitures.id, id))
        .limit(1);
      if (!row) return;
      const recipients = await db
        .select({ email: users.emailId })
        .from(users)
        .innerJoin(emdForfeitures, eq(emdForfeitures.bidderId, users.bidderId))
        .where(and(eq(emdForfeitures.id, id), eq(users.isActive, true)))
        .orderBy(desc(users.isOwner));
      const emailTo = [...new Set(recipients.map((r) => r.email?.trim()).filter(Boolean))].join(",");
      if (!emailTo) return;

      const auctionNumber = row.auctionNumber ?? `#${row.auctionId}`;
      await enqueueEmail({
        notificationId: NOTIFICATION_TYPE_EMD_FORFEITED,
        emailTo,
        subject: buildEmdForfeitureEmailSubject(auctionNumber),
        emailBody: buildEmdForfeitureEmailHtml({
          companyName: row.bidderName,
          auctionNumber,
          lots: row.lotsLabel,
          amount: formatCurrency(toAmount(row.amount), { fractionDigits: 2 }),
          reason: [row.dispositionLabel, row.requestedRemarks].filter(Boolean).join(": "),
        }),
        auctionId: row.auctionId,
        sourceType: EMAIL_SOURCE_TYPE_EMD_FORFEITURE,
        sourceId: id,
        enqueuedBy: userId,
      });
    } catch (e) {
      console.error("[emd-forfeitures] bidder notification failed", id, e);
    }
  }
}

export const emdForfeituresService = new EmdForfeituresService();

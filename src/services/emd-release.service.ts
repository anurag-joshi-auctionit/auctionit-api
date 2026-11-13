import { and, eq, inArray, sql } from "drizzle-orm";
import { formatCurrency } from "@auctionit/lib/currency";
import { EmdUiMessages } from "@auctionit/messages/emd";
import { db } from "../db/index.js";
import { emdWinningLotReleases } from "../db/schema/index.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import { emdRangeLabel } from "../lib/emd/range-label.js";
import {
  isPendingLot,
  planWinningLotRelease,
  type HoldingLot,
  type HoldingWinning,
} from "../lib/emd/winning-lot-release.js";
import {
  emdReportsService,
  type BidderEmdReportPage,
  type BidderEmdReportSummary,
} from "./emd-reports.service.js";
import { emdTransactionsService, type Tx } from "./emd-transactions.service.js";
import { clampPagination } from "./list-query.js";

/** Pending won lots listed in the release dialog; one bidder rarely has more. */
const PENDING_LOTS_CAP = 1000;

export type EmdReleaseSummary = BidderEmdReportSummary & { bidders: number };

export type EmdPendingLot = {
  lotId: number;
  auctionId: number;
  auctionNumber: string | null;
  auctionDate: string | null;
  clientName: string | null;
  lotNumber: string | null;
  title: string | null;
  emdRangeId: number | null;
  /** Label of the EMD range, e.g. "Lot 3" or "Lots 3-4"; null for migrated holdings. */
  emdRangeLabel: string | null;
  /**
   * Full EMD configured for the lot's range in EMD Setup — shared by every
   * lot in it. Not the amount currently held: a bidder's held amount per
   * range can be less once their ranges' EMD sum exceeds the auction's
   * consolidated EMD cap.
   */
  emdAmount: number;
  /** Won lots sharing this holding's Winning. */
  lotsInRange: number;
  forfeitureOpen: boolean;
};

export type EmdReleaseRowStatus = "released" | "cleared" | "failed";

export type EmdReleaseRowResult = {
  lotId: number;
  status: EmdReleaseRowStatus;
  message: string;
};

export type EmdLotReleaseResult = {
  results: EmdReleaseRowResult[];
  lotsReleased: number;
  rangesReleased: number;
  amountReleased: number;
  balance: number;
};

export type EmdReleaseHistoryRow = {
  id: number;
  bidderId: number;
  bidderName: string | null;
  auctionId: number;
  auctionNumber: string | null;
  lotId: number;
  lotNumber: string | null;
  title: string | null;
  remarks: string;
  /** Request: the admin clearing the lot. */
  requestedAt: string;
  requestedByName: string | null;
  /** Release: the credit posting. All null while still pending (see `pendingReason`). */
  releaseId: number | null;
  /**
   * Total credited by this request's release action — including any sibling
   * ranges it swept along, not just this row's own range. Meaningful only
   * when `releasedWithIds` is empty (this row is what triggered the credit);
   * a covered row (see `releasedWithIds`) ignores it.
   */
  releaseAmount: number | null;
  releasedAt: string | null;
  releasedByName: string | null;
  /** Requests whose release action posted this row's credit, when this request was covered by another's (possibly a different EMD range); else empty. */
  releasedWithIds: number[];
  /**
   * Why `releaseId` is still null: another lot of the same EMD range hasn't
   * been decided yet, or every lot in this range is decided but the bidder's
   * other EMD ranges still consume the auction's consolidated EMD cap.
   * Undefined once released.
   */
  pendingReason?: "within_range" | "cross_range";
};

type HoldingLotRow = {
  auction_id: number;
  emd_range_id: number | null;
  winning: string;
  /** Full EMD-range amount (not what's currently held); null for the no-range/legacy holding. */
  nominal_amount: string | null;
  /** Auction's consolidated EMD ceiling; null when unset. */
  consolidated_emd: string | null;
  /** EMD range's display order, for allocating a shared release pool across decided siblings; null for the no-range/legacy holding. */
  range_display_order: number | null;
  range_from: string | null;
  range_to: string | null;
  lots_in_range: number;
  lot_id: number;
  lot_number: string | null;
  title: string | null;
  auction_number: string | null;
  auction_date: string | null;
  client_name: string | null;
  rejected: boolean;
  released: boolean;
  forfeiture_open: boolean;
  /** Remark already on file when this lot was released by an earlier request; null otherwise. */
  stored_remarks: string | null;
};

const LOT_TITLE_SQL = sql`(
  SELECT COALESCE(NULLIF(it.name, ''), NULLIF(ali.material_name, ''), ali.material_description)
  FROM auction_lot_items ali
  LEFT JOIN items it ON it.id = ali.item_id
  WHERE ali.lot_id = al.id AND ali.is_active
  ORDER BY ali.id LIMIT 1
)`;

/**
 * Every won lot of the bidder's holds (auction, range) still above zero, with
 * the flags that decide whether it is pending. Lots come from `lot_ids` of the
 * hold in `emd_range_holds`.
 */
function holdingLotsSql(bidderId: number) {
  return sql`
    WITH w AS (
      SELECT h.auction_id, h.emd_range_id, h.lot_ids,
             (h.amount_held - h.amount_released - h.amount_forfeited) AS winning
      FROM emd_range_holds h
      WHERE h.bidder_id = ${bidderId}
        AND h.amount_held - h.amount_released - h.amount_forfeited > 0
    ),
    wl AS (
      SELECT DISTINCT w.auction_id, w.emd_range_id, l.lot_id
      FROM w, unnest(w.lot_ids) AS l(lot_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM auction_lot_bidder_maps m
        WHERE m.auction_id = w.auction_id AND m.bidder_id = ${bidderId}
          AND m.lot_id = l.lot_id AND COALESCE(m.is_emd_with_client, false) = true
      )
    )
    SELECT w.auction_id, w.emd_range_id, w.winning,
           aler.emd_amount AS nominal_amount, a.consolidated_emd_amount AS consolidated_emd,
           aler.display_order AS range_display_order,
           aler.lot_display_order_from AS range_from, aler.lot_display_order_to AS range_to,
           COUNT(*) OVER (PARTITION BY w.auction_id, w.emd_range_id)::int AS lots_in_range,
           wl.lot_id, al.lot_number, ${LOT_TITLE_SQL} AS title,
           a.auction_number, a.auction_date, c.company_name AS client_name,
           (al.is_approved = false OR al.is_active = false) AS rejected,
           EXISTS (
             SELECT 1 FROM emd_winning_lot_releases r
             WHERE r.bidder_id = ${bidderId} AND r.lot_id = wl.lot_id
           ) AS released,
           (
             SELECT r.remarks FROM emd_winning_lot_releases r
             WHERE r.bidder_id = ${bidderId} AND r.lot_id = wl.lot_id
             LIMIT 1
           ) AS stored_remarks,
           EXISTS (
             SELECT 1 FROM emd_forfeitures f
             WHERE f.auction_id = w.auction_id AND f.bidder_id = ${bidderId}
               AND f.emd_range_id IS NOT DISTINCT FROM w.emd_range_id
               AND f.status <> 'rejected'
           ) AS forfeiture_open
    FROM w
    JOIN wl ON wl.auction_id = w.auction_id
           AND wl.emd_range_id IS NOT DISTINCT FROM w.emd_range_id
    JOIN auction_lots al ON al.id = wl.lot_id
    LEFT JOIN auctions a ON a.auction_id = w.auction_id
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN auction_lot_emd_ranges aler ON aler.id = w.emd_range_id
    ORDER BY a.auction_date DESC NULLS LAST, w.auction_id DESC,
             al.display_order NULLS LAST, al.id
  `;
}

function toHoldingLot(r: HoldingLotRow): HoldingLot {
  return {
    lotId: r.lot_id,
    auctionId: r.auction_id,
    emdRangeId: r.emd_range_id,
    released: r.released,
    rejected: r.rejected,
    forfeitureOpen: r.forfeiture_open,
  };
}

function toHoldingWinning(rows: HoldingLotRow[]): HoldingWinning[] {
  const byKey = new Map<string, HoldingWinning>();
  for (const r of rows) {
    const winning = toAmount(r.winning);
    byKey.set(`${r.auction_id}:${r.emd_range_id ?? 0}`, {
      auctionId: r.auction_id,
      emdRangeId: r.emd_range_id,
      winning,
      nominalAmount: r.nominal_amount != null ? toAmount(r.nominal_amount) : winning,
      consolidatedEmd: r.consolidated_emd != null ? toAmount(r.consolidated_emd) : null,
      rangeOrder: r.range_display_order,
    });
  }
  return [...byKey.values()];
}

/** Ledger remarks of a range credit: the remarks of the lots that completed it. */
function joinRemarks(remarks: string[]): string {
  return [...new Set(remarks)].join("; ").slice(0, 500);
}

export class EmdReleaseService {
  bidders(opts: { q?: string; page: number; pageSize: number }): Promise<BidderEmdReportPage> {
    return emdReportsService.bidderWise({ ...opts, heldOnly: true });
  }

  async summary(filters: { q?: string }): Promise<EmdReleaseSummary> {
    const f = { ...filters, heldOnly: true };
    const [totals, bidders] = await Promise.all([
      emdReportsService.bidderWiseSummary(f),
      emdReportsService.bidderCount(f),
    ]);
    return { ...totals, bidders };
  }

  /** Won lots of the bidder still waiting on an admin release. */
  async pendingLots(bidderId: number): Promise<{ items: EmdPendingLot[] }> {
    const res = await db.execute<HoldingLotRow>(holdingLotsSql(bidderId));
    const items = res.rows
      .filter((r) => isPendingLot(toHoldingLot(r)))
      .slice(0, PENDING_LOTS_CAP)
      .map((r) => ({
        lotId: r.lot_id,
        auctionId: r.auction_id,
        auctionNumber: r.auction_number,
        auctionDate: r.auction_date,
        clientName: r.client_name,
        lotNumber: r.lot_number,
        title: r.title,
        emdRangeId: r.emd_range_id,
        emdRangeLabel:
          r.range_from != null && r.range_to != null
            ? emdRangeLabel(toAmount(r.range_from), toAmount(r.range_to))
            : null,
        emdAmount: toAmount(r.nominal_amount ?? r.winning),
        lotsInRange: r.lots_in_range,
        forfeitureOpen: r.forfeiture_open,
      }));
    return { items };
  }

  /**
   * Releases won lots. Every row is checked on its own: an invalid row is
   * skipped and reported, never failing the rows around it. Each accepted lot
   * is recorded; a holding whose last pending lot clears has its remaining
   * hold credited back as `release_winning_by_admin`, linked from every
   * lot row it covers. Rows of a holding still left with a pending lot are
   * saved with no credit — the money stays held until the rest clear too.
   */
  async releaseLots(input: {
    bidderId: number;
    lots: { lotId: number; remarks: string }[];
    userId: number;
  }): Promise<EmdLotReleaseResult> {
    return emdTransactionsService.run(async (tx) => {
      await emdTransactionsService.lockBidders(tx, [input.bidderId]);
      const rows = (await tx.execute<HoldingLotRow>(holdingLotsSql(input.bidderId))).rows;
      const plan = planWinningLotRelease({
        lots: rows.map(toHoldingLot),
        winning: toHoldingWinning(rows),
        requested: input.lots,
      });

      const rowByLot = new Map(rows.map((r) => [r.lot_id, r]));
      const remarksByLot = new Map(input.lots.map((l) => [l.lotId, l.remarks]));

      const accepted = input.lots.filter((_, i) => plan.results[i]!.error == null);
      if (accepted.length > 0) {
        await tx.insert(emdWinningLotReleases).values(
          accepted.map((l) => {
            const r = rowByLot.get(l.lotId)!;
            return {
              auctionId: r.auction_id,
              bidderId: input.bidderId,
              lotId: l.lotId,
              emdRangeId: r.emd_range_id,
              remarks: l.remarks,
              createdBy: input.userId,
            };
          }),
        );
      }

      let amountReleased = 0;
      const releasedAmountByLot = new Map<number, number>();
      if (plan.releases.length > 0) {
        const inputs = plan.releases.map((release) => {
          amountReleased = round2(amountReleased + release.amount);
          for (const lotId of release.lotIds) releasedAmountByLot.set(lotId, release.amount);
          // Every lot of the holding: this request's remark, or (for a lot
          // decided and cleared by an earlier request, now auto-released as
          // the bidder's other EMD ranges freed up the consolidated cap) the
          // remark already on file for it.
          const remarks = joinRemarks(
            release.lotIds
              .map((lotId) => remarksByLot.get(lotId) ?? rowByLot.get(lotId)?.stored_remarks ?? "")
              .filter((r) => r !== ""),
          );
          return {
            bidderId: input.bidderId,
            emdType: "release_winning_by_admin" as const,
            amount: release.amount,
            auctionId: release.auctionId,
            emdRangeId: release.emdRangeId,
            winningLotIds: release.lotIds,
            remarks,
            createdBy: input.userId,
          };
        });
        const ids = await emdTransactionsService.postMany(tx, inputs);
        for (const release of plan.releases) {
          await tx.execute(sql`
            UPDATE emd_range_holds
            SET amount_released = amount_released + ${release.amount}, updated_at = now()
            WHERE auction_id = ${release.auctionId} AND bidder_id = ${input.bidderId}
              AND emd_range_id IS NOT DISTINCT FROM ${release.emdRangeId}::int
          `);
        }
        await linkReleases(
          tx,
          input.bidderId,
          plan.releases.map((r, i) => ({ lotIds: r.lotIds, transactionId: ids[i]! })),
        );
      }

      const deferredHoldings = new Set(
        plan.deferred.map((d) => `${d.auctionId}:${d.emdRangeId ?? 0}`),
      );
      const results: EmdReleaseRowResult[] = plan.results.map((r) => {
        if (r.error) return { lotId: r.lotId, status: "failed", message: r.error };
        const released = releasedAmountByLot.get(r.lotId);
        if (released != null) {
          return {
            lotId: r.lotId,
            status: "released",
            message: EmdUiMessages.RELEASE_ROW_RELEASED(formatCurrency(released)),
          };
        }
        const row = rowByLot.get(r.lotId);
        const isCrossRangeDeferred =
          row != null && deferredHoldings.has(`${row.auction_id}:${row.emd_range_id ?? 0}`);
        return {
          lotId: r.lotId,
          status: "cleared",
          message: isCrossRangeDeferred
            ? EmdUiMessages.RELEASE_ROW_CLEARED_CONSOLIDATED
            : EmdUiMessages.RELEASE_ROW_CLEARED,
        };
      });

      return {
        results,
        lotsReleased: accepted.length,
        rangesReleased: plan.releases.length,
        amountReleased,
        balance: await emdTransactionsService.availableBalance(tx, input.bidderId),
      };
    });
  }

  async history(opts: {
    q?: string;
    /** Date range (inclusive, IST calendar day) on the release request's created_at. */
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: EmdReleaseHistoryRow[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const q = opts.q?.trim();
    const conditions = [
      q
        ? sql`(b.company_name ILIKE ${`%${q}%`} OR b.id::text ILIKE ${`%${q}%`}
               OR a.auction_number ILIKE ${`%${q}%`} OR al.lot_number ILIKE ${`%${q}%`})`
        : undefined,
      opts.from
        ? sql`(r.created_at AT TIME ZONE 'Asia/Kolkata')::date >= CAST(${opts.from} AS date)`
        : undefined,
      opts.to
        ? sql`(r.created_at AT TIME ZONE 'Asia/Kolkata')::date <= CAST(${opts.to} AS date)`
        : undefined,
    ].filter((c) => c != null);
    const filter = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
    // WHERE must come after every JOIN, so all joins (not just the ones the
    // filter reads) live here and `filter` is appended last.
    const from = sql`
      FROM emd_winning_lot_releases r
      JOIN bidders b ON b.id = r.bidder_id
      JOIN auction_lots al ON al.id = r.lot_id
      LEFT JOIN auctions a ON a.auction_id = r.auction_id
      LEFT JOIN emd_transactions t ON t.id = r.transaction_id
      LEFT JOIN users u ON u.id = r.created_by
      LEFT JOIN users tu ON tu.id = t.created_by
      ${filter}
    `;
    const [rows, count] = await Promise.all([
      db.execute<{
        id: number;
        bidder_id: number;
        bidder_name: string | null;
        auction_id: number;
        auction_number: string | null;
        lot_id: number;
        lot_number: string | null;
        title: string | null;
        remarks: string;
        transaction_id: number | null;
        amount: string | null;
        released_at: string | null;
        released_by_name: string | null;
        released_with: string | null; // comma-separated request ids, null when this request posted the credit
        created_at: string;
        created_by_name: string | null;
        pending_reason: "within_range" | "cross_range" | null;
      }>(sql`
        SELECT r.id, r.bidder_id, b.company_name AS bidder_name, r.auction_id, a.auction_number,
               r.lot_id, al.lot_number, ${LOT_TITLE_SQL} AS title, r.remarks, r.transaction_id,
               -- One release action (one releaseLots call) can post several
               -- transactions at once (one per range it completes); every one of
               -- them shares the exact same created_at (one outer DB transaction).
               -- The amount shown is the whole action's total, not just this row's
               -- own range, so a request that swept sibling ranges along shows what
               -- actually moved.
               (
                 SELECT SUM(batch.amount) FROM (
                   SELECT DISTINCT tx.id, tx.amount
                   FROM emd_winning_lot_releases r2
                   JOIN emd_transactions tx ON tx.id = r2.transaction_id
                   WHERE r2.bidder_id = r.bidder_id AND tx.created_at = t.created_at
                 ) batch
               ) AS amount,
               t.created_at AS released_at, tu.name AS released_by_name,
               -- This row's own request wasn't what triggered its credit (another
               -- request in the same action was) when its created_at doesn't match
               -- the batch's: point it at whichever request(s) in that same action
               -- were themselves created at the credit's moment (the ones an admin
               -- actually submitted, as opposed to a sibling range swept along).
               CASE WHEN r.created_at IS DISTINCT FROM t.created_at THEN
                 (
                   SELECT string_agg(driver.id::text, ',' ORDER BY driver.id)
                   FROM (
                     SELECT DISTINCT r2.id
                     FROM emd_winning_lot_releases r2
                     JOIN emd_transactions tx2 ON tx2.id = r2.transaction_id
                     WHERE r2.bidder_id = r.bidder_id
                       AND tx2.created_at = t.created_at
                       AND r2.created_at = tx2.created_at
                   ) driver
                 )
               END AS released_with,
               r.created_at, u.name AS created_by_name,
               CASE
                 WHEN r.transaction_id IS NOT NULL THEN NULL
                 WHEN EXISTS (
                   SELECT 1 FROM emd_range_holds h, unnest(h.lot_ids) AS lid(lot_id)
                   JOIN auction_lots sibling ON sibling.id = lid.lot_id
                   WHERE h.bidder_id = r.bidder_id AND h.auction_id = r.auction_id
                     AND h.emd_range_id IS NOT DISTINCT FROM r.emd_range_id
                     AND sibling.is_approved = true AND sibling.is_active = true
                     AND NOT EXISTS (
                       SELECT 1 FROM emd_winning_lot_releases r2
                       WHERE r2.bidder_id = r.bidder_id AND r2.lot_id = lid.lot_id
                     )
                 ) THEN 'within_range'
                 ELSE 'cross_range'
               END AS pending_reason
        ${from}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n ${from}`),
    ]);
    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        bidderId: r.bidder_id,
        bidderName: r.bidder_name,
        auctionId: r.auction_id,
        auctionNumber: r.auction_number,
        lotId: r.lot_id,
        lotNumber: r.lot_number,
        title: r.title,
        remarks: r.remarks,
        requestedAt: r.created_at,
        requestedByName: r.created_by_name,
        releaseId: r.transaction_id,
        releaseAmount: r.transaction_id == null ? null : toAmount(r.amount),
        releasedAt: r.released_at,
        releasedByName: r.released_by_name,
        releasedWithIds: r.released_with ? r.released_with.split(",").map(Number) : [],
        pendingReason: r.pending_reason ?? undefined,
      })),
      total: count.rows[0]?.n ?? 0,
      page,
      pageSize,
    };
  }
}

/** Points every lot row of each released holding at its credit. */
async function linkReleases(
  tx: Tx,
  bidderId: number,
  links: { lotIds: number[]; transactionId: number }[],
): Promise<void> {
  for (const link of links) {
    await tx
      .update(emdWinningLotReleases)
      .set({ transactionId: link.transactionId })
      .where(
        and(
          eq(emdWinningLotReleases.bidderId, bidderId),
          inArray(emdWinningLotReleases.lotId, link.lotIds),
        ),
      );
  }
}

export const emdReleaseService = new EmdReleaseService();

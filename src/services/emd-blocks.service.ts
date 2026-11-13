import { and, eq, sql } from "drizzle-orm";
import { EmdErrorMessages } from "@auctionit/messages/emd";
import { db } from "../db/index.js";
import {
  auctions,
  bidders,
  EMD_REFUND_OPEN_STATUSES,
  emdTransactions,
  type EmdBlockStatus,
  type EmdSettlementJobStatus,
  type EmdType,
} from "../db/schema/index.js";
import { round2, sqlInList, toAmount } from "../lib/emd/constants.js";
import { EmdError } from "../lib/emd/errors.js";
import {
  blockedByAuctionSql,
  blockedOnAuctionSql,
  holdsByRangeSql,
  liveBlockOnAuctionSql,
} from "../lib/emd/blocked.js";
import { clampPagination } from "./list-query.js";
import { emdTransactionsService, type Tx } from "./emd-transactions.service.js";

export type EmdBlocked = {
  auctionId: number;
  auctionNumber: string | null;
  clientName: string | null;
  blocked: number;
  blockStatus: EmdBlockStatus | null;
  blockedAt: string | null;
  auctionStatus: string | null;
  settlementStatus: EmdSettlementJobStatus | null;
  lots: string[];
};

export type EmdBlockedBreakdownRow = {
  bidderId: number;
  auctionId: number;
  auctionNumber: string | null;
  auctionDate: string | null;
  blocked: number;
  lots: string[];
};

export type EmdBalanceTotals = {
  available: number;
  blocked: number;
};

export type EmdBidderSummary = EmdBalanceTotals & {
  bidderId: number;
  bidderName: string;
  van: string | null;
  refundPending: number;
  forfeited: number;
  total: number;
  settlementPendingCount: number;
};

type ReleaseFullType = Extract<
  EmdType,
  "release_bidder_detached" | "release_bidder_unverified" | "release_lot_withdrawn"
>;

/** "Lot 4" / "Lots 4, 7" from lot numbers, in display order; null when empty. */
export async function emdLotsLabel(executor: Tx | typeof db, lotIds: number[]): Promise<string | null> {
  if (lotIds.length === 0) return null;
  const rows = await executor.execute<{ id: number; lot_number: string | null }>(sql`
    SELECT id, lot_number FROM auction_lots
    WHERE id = ANY(${`{${lotIds.join(",")}}`}::int[])
    ORDER BY display_order NULLS LAST, id
  `);
  const labels = rows.rows.map((r) => r.lot_number ?? `#${r.id}`);
  if (labels.length === 0) return null;
  return `${labels.length === 1 ? "Lot" : "Lots"} ${labels.join(", ")}`;
}

export class EmdBlocksService {
  async totals(bidderId: number): Promise<EmdBalanceTotals> {
    const [row] = await db
      .select({
        available: bidders.emdAvailableBalance,
        blocked: bidders.emdBlockedBalance,
      })
      .from(bidders)
      .where(eq(bidders.id, bidderId))
      .limit(1);
    if (!row) throw EmdError.notFound(EmdErrorMessages.BIDDER_NOT_FOUND);
    return {
      available: toAmount(row.available),
      blocked: toAmount(row.blocked),
    };
  }

  /** Balance cards: Available, Blocked, Refund in process, Forfeited, Total. */
  async summary(bidderId: number): Promise<EmdBidderSummary> {
    const rows = await db.execute<{
      company_name: string;
      van: string | null;
      available: string;
      blocked: string;
      refund_pending: string | null;
      forfeited: string | null;
      settlement_pending: number;
    }>(sql`
      SELECT b.company_name, b.van,
             b.emd_available_balance AS available,
             b.emd_blocked_balance AS blocked,
             (SELECT SUM(r.amount) FROM emd_refunds r
               WHERE r.bidder_id = b.id
                 AND r.status IN (${sql.raw(sqlInList(EMD_REFUND_OPEN_STATUSES))})) AS refund_pending,
             (SELECT SUM(f.amount) FROM emd_forfeitures f
               WHERE f.bidder_id = b.id
                 AND f.status = 'forfeited') AS forfeited,
             (SELECT count(DISTINCT j.auction_id)::int FROM emd_settlement_jobs j
               WHERE j.status IN ('queued', 'running', 'paused')
                 AND EXISTS (SELECT 1 FROM emd_transactions t
                              WHERE t.bidder_id = b.id AND t.auction_id = j.auction_id)) AS settlement_pending
      FROM bidders b WHERE b.id = ${bidderId}
    `);
    const row = rows.rows[0];
    if (!row) throw EmdError.notFound(EmdErrorMessages.BIDDER_NOT_FOUND);
    const available = toAmount(row.available);
    const blocked = toAmount(row.blocked);
    const refundPending = toAmount(row.refund_pending);
    const forfeited = toAmount(row.forfeited);
    return {
      bidderId,
      bidderName: row.company_name,
      van: row.van,
      available,
      blocked,
      refundPending,
      forfeited,
      total: round2(available + blocked + refundPending),
      settlementPendingCount: row.settlement_pending ?? 0,
    };
  }

  /**
   * The block of one bidder on one auction that attach, detach and re-block
   * work on, read inside the caller's tx: the Blocked balance minus what stays
   * held for won ranges after a close (a reopened auction keeps those).
   */
  async blockedOnAuction(executor: Tx | typeof db, bidderId: number, auctionId: number): Promise<number> {
    const rows = await executor.execute<{ blocked: string }>(liveBlockOnAuctionSql(auctionId, [bidderId]));
    return round2(toAmount(rows.rows[0]?.blocked));
  }

  /**
   * A bidder's whole already-blocked balance on one auction, held-for-winning
   * included — unlike `blockedOnAuction`, which is only the re-blockable live
   * portion. Used where the caller wants the full post-close picture (e.g. a
   * winner-correction preview), not the pre-close attach/detach working set.
   */
  async totalBlockedOnAuction(
    executor: Tx | typeof db,
    bidderId: number,
    auctionId: number,
  ): Promise<number> {
    const rows = await executor.execute<{ blocked: string }>(blockedOnAuctionSql(auctionId, [bidderId]));
    return round2(Math.max(toAmount(rows.rows[0]?.blocked), 0));
  }

  /**
   * Each bidder's already-blocked amount and block status on one auction,
   * before any new attach — context for the Attach Bidders preview, which
   * otherwise only shows the requirement for newly selected lots.
   */
  async alreadyBlockedForBidders(
    bidderIds: number[],
    auctionId: number,
  ): Promise<Map<number, { amount: number; status: EmdBlockStatus | null }>> {
    const result = new Map<number, { amount: number; status: EmdBlockStatus | null }>();
    if (bidderIds.length === 0) return result;

    const [amounts, statuses] = await Promise.all([
      db.execute<{ bidder_id: number; blocked: string }>(liveBlockOnAuctionSql(auctionId, bidderIds)),
      db.execute<{ bidder_id: number; block_status: EmdBlockStatus | null }>(sql`
        SELECT DISTINCT ON (t.bidder_id) t.bidder_id, t.block_status
        FROM emd_transactions t
        WHERE t.auction_id = ${auctionId}
          AND t.bidder_id = ANY(${`{${bidderIds.join(",")}}`}::int[])
          AND t.block_status IS NOT NULL
        ORDER BY t.bidder_id, t.id DESC
      `),
    ]);
    const amountByBidder = new Map(amounts.rows.map((r) => [r.bidder_id, toAmount(r.blocked)] as const));
    const statusByBidder = new Map(statuses.rows.map((r) => [r.bidder_id, r.block_status] as const));
    for (const bidderId of bidderIds) {
      result.set(bidderId, {
        amount: round2(Math.max(amountByBidder.get(bidderId) ?? 0, 0)),
        status: statusByBidder.get(bidderId) ?? null,
      });
    }
    return result;
  }


  /**
   * Moves a bidder's block on one auction to `targetAmount`, keeping exactly one
   * active `blocked_bidder_attached` entry per (auction, bidder). Callers pass
   * the EMD required for the bidder's *whole* current lot set, recomputed after
   * every attach or detach — not a delta.
   *
   * Raising and lowering both post the reversal and the new block in a single
   * `postMany`, so the Available guard sees the net movement rather than the
   * gross debit, and the reversal pair nets to zero in the passbook.
   *
   * Omitting `blockStatus` carries forward the status of the block being
   * superseded, which is what a detach wants — it changes the amount, not the
   * operator's original full/partial/exception decision.
   */
  async reconcileBlock(
    tx: Tx,
    input: {
      auctionId: number;
      bidderId: number;
      targetAmount: number;
      blockStatus?: EmdBlockStatus | null;
      lotIds: number[] | null;
      userId: number;
    },
  ): Promise<boolean> {
    await emdTransactionsService.lockBidders(tx, [input.bidderId]);
    const alreadyBlocked = await this.blockedOnAuction(tx, input.bidderId, input.auctionId);
    const target = round2(Math.max(input.targetAmount, 0));
    if (alreadyBlocked === 0 && target === 0) return false;

    const inputs: Parameters<typeof emdTransactionsService.postMany>[1] = [];
    let blockStatus = input.blockStatus ?? null;

    if (alreadyBlocked > 0) {
      const [superseded] = await tx
        .select({
          id: emdTransactions.id,
          blockStatus: emdTransactions.blockStatus,
          blockLotIds: emdTransactions.blockLotIds,
        })
        .from(emdTransactions)
        .where(
          and(
            eq(emdTransactions.bidderId, input.bidderId),
            eq(emdTransactions.auctionId, input.auctionId),
            eq(emdTransactions.emdType, "blocked_bidder_attached"),
            sql`NOT EXISTS (
              SELECT 1 FROM emd_transactions r
              WHERE r.reverses_transaction_id = ${emdTransactions.id}
            )`,
          ),
        )
        .orderBy(sql`${emdTransactions.id} DESC`)
        .limit(1);
      // Same amount (e.g. a detach inside an EMD range that keeps a lot): only
      // re-post when the lot snapshot changed, so the passbook Lots column
      // follows the attached lots without moving any money.
      if (target === alreadyBlocked && !this.lotSetChanged(superseded?.blockLotIds, input.lotIds)) {
        return false;
      }
      if (input.blockStatus === undefined) blockStatus = superseded?.blockStatus ?? null;
      inputs.push({
        bidderId: input.bidderId,
        emdType: "release_block_revised",
        amount: alreadyBlocked,
        auctionId: input.auctionId,
        reversesTransactionId: superseded?.id,
        blockLotIds: superseded?.blockLotIds ?? null,
        createdBy: input.userId,
      });
    }

    if (target > 0) {
      inputs.push({
        bidderId: input.bidderId,
        emdType: "blocked_bidder_attached",
        amount: target,
        auctionId: input.auctionId,
        blockStatus,
        blockLotIds: input.lotIds,
        createdBy: input.userId,
      });
    }

    await emdTransactionsService.postMany(tx, inputs);
    return true;
  }

  /**
   * True when the new snapshot differs from the stored one (order ignored). A
   * row without a snapshot predates the column and already reads the bidder's
   * current lots, so it never needs re-posting.
   */
  private lotSetChanged(
    stored: number[] | null | undefined,
    next: number[] | null,
  ): boolean {
    if (next == null) return false;
    if (stored == null) return false;
    if (stored.length !== next.length) return true;
    const set = new Set(stored);
    return next.some((id) => !set.has(id));
  }

  /** Releases a bidder's whole remaining block on an auction (system releases). */
  async releaseFullBlock(
    tx: Tx,
    input: {
      auctionId: number;
      bidderId: number;
      emdType: ReleaseFullType;
      remarks?: string | null;
      lotIds?: number[] | null;
      userId: number;
    },
  ): Promise<number> {
    await emdTransactionsService.lockBidders(tx, [input.bidderId]);
    const blocked = await this.blockedOnAuction(tx, input.bidderId, input.auctionId);
    if (blocked <= 0) return 0;
    await emdTransactionsService.post(tx, {
      bidderId: input.bidderId,
      emdType: input.emdType,
      amount: blocked,
      auctionId: input.auctionId,
      remarks: input.remarks ?? null,
      blockLotIds: input.lotIds ?? null,
      createdBy: input.userId,
    });
    return blocked;
  }

  /** Lots whose rejection already released the winner's EMD; their decision is final. */
  async lotsReleasedOnRejection(auctionId: number, lotIds: number[] | "all"): Promise<number[]> {
    if (lotIds !== "all" && lotIds.length === 0) return [];
    const rows = await db.execute<{ lot_id: number }>(sql`
      SELECT DISTINCT l.lot_id
      FROM emd_transactions t, unnest(t.winning_lot_ids) AS l(lot_id)
      WHERE t.auction_id = ${auctionId} AND t.emd_type = 'release_lot_rejected'
        ${lotIds === "all" ? sql`` : sql`AND l.lot_id = ANY(${`{${lotIds.join(",")}}`}::int[])`}
      ORDER BY l.lot_id
    `);
    return rows.rows.map((r) => r.lot_id);
  }

  /**
   * Releases the EMD held for a range once every lot it covers is rejected by
   * the client. One hold covers all won lots of a range, so rejecting one of
   * several leaves the EMD blocked. Only holds that cover `lotIds` are
   * considered; re-running is a no-op.
   */
  async releaseOnLotRejection(auctionId: number, lotIds: number[] | "all", userId: number): Promise<void> {
    if (lotIds !== "all" && lotIds.length === 0) return;
    await emdTransactionsService.run(async (tx) => {
      const groups = await tx.execute<{
        bidder_id: number;
        emd_range_id: number | null;
        lot_ids: number[];
        held: string;
      }>(sql`
        SELECT h.bidder_id, h.emd_range_id, h.lot_ids,
               (h.amount_held - h.amount_released - h.amount_forfeited) AS held
        FROM emd_range_holds h
        WHERE h.auction_id = ${auctionId}
          AND h.amount_held - h.amount_released - h.amount_forfeited > 0
          AND ${lotIds === "all" ? sql`true` : sql`h.lot_ids && ${`{${lotIds.join(",")}}`}::int[]`}
          AND EXISTS (
            SELECT 1 FROM auction_lots l
            WHERE l.id = ANY(h.lot_ids) AND l.is_active AND l.is_approved = false
          )
          AND NOT EXISTS (
            SELECT 1 FROM auction_lots l
            WHERE l.id = ANY(h.lot_ids) AND l.is_active AND l.is_approved IS DISTINCT FROM false
          )
        ORDER BY h.bidder_id, h.emd_range_id
      `);
      if (groups.rows.length === 0) return;
      await emdTransactionsService.lockBidders(tx, groups.rows.map((g) => g.bidder_id));

      const inputs = [];
      for (const g of groups.rows) {
        const amount = round2(toAmount(g.held));
        if (amount <= 0) continue;
        inputs.push({
          bidderId: g.bidder_id,
          emdType: "release_lot_rejected" as const,
          amount,
          auctionId,
          emdRangeId: g.emd_range_id,
          winningLotIds: g.lot_ids,
          createdBy: userId,
        });
        await tx.execute(sql`
          UPDATE emd_range_holds
          SET amount_released = amount_released + ${amount}, updated_at = now()
          WHERE auction_id = ${auctionId} AND bidder_id = ${g.bidder_id}
            AND emd_range_id IS NOT DISTINCT FROM ${g.emd_range_id}::int
        `);
      }
      await emdTransactionsService.postMany(tx, inputs);
    });
  }

  /** Blocked per auction for one bidder (non-zero rows only). */
  async blocked(
    bidderId: number,
    opts: { page: number; pageSize: number },
  ): Promise<{ items: EmdBlocked[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const base = sql`
      WITH h AS (
        SELECT q.auction_id, GREATEST(q.blocked, 0) AS blocked
        FROM (${blockedByAuctionSql([bidderId])}) q
      ),
      held AS (
        SELECT q.auction_id, SUM(q.held) AS held
        FROM (${holdsByRangeSql([bidderId])}) q
        GROUP BY q.auction_id
      )
    `;
    const [rows, totalRows] = await Promise.all([
      db.execute<{
        auction_id: number;
        auction_number: string | null;
        client_name: string | null;
        blocked: string;
        block_status: EmdBlockStatus | null;
        blocked_at: string | null;
        auction_status: string | null;
        settlement_status: EmdSettlementJobStatus | null;
        lots: string[] | null;
      }>(sql`
        ${base}
        SELECT h.auction_id, a.auction_number, c.company_name AS client_name,
               h.blocked, a.status AS auction_status,
               (SELECT t.block_status FROM emd_transactions t
                 WHERE t.bidder_id = ${bidderId} AND t.auction_id = h.auction_id
                   AND t.block_status IS NOT NULL
                 ORDER BY t.id DESC LIMIT 1) AS block_status,
               (SELECT MIN(t.created_at) FROM emd_transactions t
                 WHERE t.bidder_id = ${bidderId} AND t.auction_id = h.auction_id
                   AND t.emd_type = 'blocked_bidder_attached') AS blocked_at,
               (SELECT j.status FROM emd_settlement_jobs j
                 WHERE j.auction_id = h.auction_id
                 ORDER BY j.id DESC LIMIT 1) AS settlement_status,
               lo.lots
        FROM h
        LEFT JOIN auctions a ON a.auction_id = h.auction_id
        LEFT JOIN clients c ON c.id = a.client_id
        LEFT JOIN held ON held.auction_id = h.auction_id
        LEFT JOIN LATERAL (
          SELECT array_agg(COALESCE(NULLIF(l.lot_number, ''), '#' || l.id)
                           ORDER BY l.display_order NULLS LAST, l.id) AS lots
          FROM (
            SELECT DISTINCT x.lot_id
            FROM (
              SELECT unnest(hd.lot_ids) AS lot_id
              FROM emd_range_holds hd
              WHERE hd.bidder_id = ${bidderId} AND hd.auction_id = h.auction_id
                AND hd.amount_held - hd.amount_released - hd.amount_forfeited > 0
              UNION ALL
              -- Only still relevant while some of the block hasn't settled into
              -- a range hold yet (a live auction's attach/detach/re-block); once
              -- the whole blocked amount is accounted for by range holds, this
              -- snapshot is stale (it isn't trimmed on release) so it's dropped.
              SELECT unnest(COALESCE(blk.block_lot_ids, ARRAY[]::int[])) AS lot_id
              FROM (
                SELECT t.block_lot_ids
                FROM emd_transactions t
                WHERE t.bidder_id = ${bidderId} AND t.auction_id = h.auction_id
                  AND t.emd_type = 'blocked_bidder_attached'
                ORDER BY t.id DESC LIMIT 1
              ) blk
              WHERE h.blocked > COALESCE(held.held, 0)
            ) x
            WHERE NOT EXISTS (
              SELECT 1 FROM auction_lot_bidder_maps m
              WHERE m.auction_id = h.auction_id AND m.bidder_id = ${bidderId}
                AND m.lot_id = x.lot_id AND COALESCE(m.is_emd_with_client, false) = true
            )
            -- Drop lots already credited back, even if the stale attach
            -- snapshot above still lists them (it isn't trimmed on release).
            AND NOT EXISTS (
              SELECT 1 FROM emd_winning_lot_releases r
              WHERE r.bidder_id = ${bidderId} AND r.lot_id = x.lot_id
                AND r.transaction_id IS NOT NULL
            )
          ) ids
          JOIN auction_lots l ON l.id = ids.lot_id
        ) lo ON true
        WHERE h.blocked > 0
        ORDER BY blocked_at DESC NULLS LAST, h.auction_id DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      db.execute<{ n: number }>(
        sql`${base} SELECT count(*)::int AS n FROM h WHERE h.blocked > 0`,
      ),
    ]);
    return {
      items: rows.rows.map((r) => ({
        auctionId: r.auction_id,
        auctionNumber: r.auction_number,
        clientName: r.client_name,
        blocked: toAmount(r.blocked),
        blockStatus: r.block_status,
        blockedAt: r.blocked_at,
        auctionStatus: r.auction_status,
        settlementStatus: r.settlement_status,
        lots: r.lots ?? [],
      })),
      total: totalRows.rows[0]?.n ?? 0,
      page,
      pageSize,
    };
  }

  /** Per-(bidder, auction) blocked breakdown for many bidders (non-zero rows only), for exports. */
  async blockedBreakdown(bidderIds: number[]): Promise<EmdBlockedBreakdownRow[]> {
    if (bidderIds.length === 0) return [];
    const base = sql`
      WITH h AS (
        SELECT q.bidder_id, q.auction_id, GREATEST(q.blocked, 0) AS blocked
        FROM (${blockedByAuctionSql(bidderIds)}) q
      ),
      held AS (
        SELECT q.bidder_id, q.auction_id, SUM(q.held) AS held
        FROM (${holdsByRangeSql(bidderIds)}) q
        GROUP BY q.bidder_id, q.auction_id
      )
    `;
    const rows = await db.execute<{
      bidder_id: number;
      auction_id: number;
      auction_number: string | null;
      auction_date: string | null;
      blocked: string;
      lots: string[] | null;
    }>(sql`
      ${base}
      SELECT h.bidder_id, h.auction_id, a.auction_number, a.auction_date, h.blocked, lo.lots
      FROM h
      LEFT JOIN auctions a ON a.auction_id = h.auction_id
      LEFT JOIN held ON held.bidder_id = h.bidder_id AND held.auction_id = h.auction_id
      LEFT JOIN LATERAL (
        SELECT array_agg(COALESCE(NULLIF(l.lot_number, ''), '#' || l.id)
                         ORDER BY l.display_order NULLS LAST, l.id) AS lots
        FROM (
          SELECT DISTINCT x.lot_id
          FROM (
            SELECT unnest(hd.lot_ids) AS lot_id
            FROM emd_range_holds hd
            WHERE hd.bidder_id = h.bidder_id AND hd.auction_id = h.auction_id
              AND hd.amount_held - hd.amount_released - hd.amount_forfeited > 0
            UNION ALL
            SELECT unnest(COALESCE(blk.block_lot_ids, ARRAY[]::int[])) AS lot_id
            FROM (
              SELECT t.block_lot_ids
              FROM emd_transactions t
              WHERE t.bidder_id = h.bidder_id AND t.auction_id = h.auction_id
                AND t.emd_type = 'blocked_bidder_attached'
              ORDER BY t.id DESC LIMIT 1
            ) blk
            WHERE h.blocked > COALESCE(held.held, 0)
          ) x
          WHERE NOT EXISTS (
            SELECT 1 FROM auction_lot_bidder_maps m
            WHERE m.auction_id = h.auction_id AND m.bidder_id = h.bidder_id
              AND m.lot_id = x.lot_id AND COALESCE(m.is_emd_with_client, false) = true
          )
        ) ids
        JOIN auction_lots l ON l.id = ids.lot_id
      ) lo ON true
      WHERE h.blocked > 0
      ORDER BY a.auction_date DESC NULLS LAST, h.auction_id DESC
    `);
    return rows.rows.map((r) => ({
      bidderId: r.bidder_id,
      auctionId: r.auction_id,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
      blocked: toAmount(r.blocked),
      lots: r.lots ?? [],
    }));
  }

  async auctionExists(auctionId: number): Promise<boolean> {
    const [row] = await db.select({ id: auctions.id }).from(auctions).where(eq(auctions.id, auctionId)).limit(1);
    return row != null;
  }
}

export const emdBlocksService = new EmdBlocksService();

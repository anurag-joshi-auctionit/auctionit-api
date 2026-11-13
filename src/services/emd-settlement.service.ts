import { and, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { EmdErrorMessages } from "@auctionit/messages/emd";
import { db } from "../db/index.js";
import { env } from "../env.js";
import {
  auctionLotBidderMaps,
  auctions,
  emdRangeHolds,
  emdSettlementJobs,
  type EmdSettlementJobKind,
  type EmdSettlementJobStatus,
  type EmdType,
} from "../db/schema/index.js";
import { EMD_SYSTEM_USER_ID, round2, toAmount } from "../lib/emd/constants.js";
import { EmdError } from "../lib/emd/errors.js";
import { blockedOnAuctionSql, liveBlockOnAuctionSql } from "../lib/emd/blocked.js";
import {
  holdWrites,
  planCloseSettlement,
  releasedLotIds,
  type SettlementRange,
  type SettlementWonLot,
} from "../lib/emd/close-settlement.js";
import { emdRangeLabel } from "../lib/emd/range-label.js";
import { clampPagination, combineConditions } from "./list-query.js";
import { emdTransactionsService, type EmdPostInput, type Tx } from "./emd-transactions.service.js";

type ClaimedJob = {
  id: number;
  auction_id: number;
  kind: EmdSettlementJobKind;
  lot_id: number | null;
  attempts: number;
  created_by: number | null;
};

export type EmdSettlementJobRow = {
  id: number;
  auctionId: number;
  auctionNumber: string | null;
  kind: EmdSettlementJobKind;
  lotId: number | null;
  status: EmdSettlementJobStatus;
  attempts: number;
  lastError: string | null;
  biddersSettled: number;
  amountReleased: number;
  amountHeld: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type EmdSettlementTickResult = { processed: number; failed: number; auctionIds: number[] };

const RELEASE_TYPE: Record<EmdSettlementJobKind, "release_auction_closed" | "release_lot_withdrawn"> = {
  auction_closed: "release_auction_closed",
  legacy_cutover: "release_auction_closed",
  lot_withdrawn: "release_lot_withdrawn",
};

/** Close-type jobs release the block except the EMD of won ranges, which stays blocked; the rest release it all. */
const SETTLES_WINNING: EmdSettlementJobKind[] = ["auction_closed", "legacy_cutover"];

function backoffMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

export class EmdSettlementService {
  /**
   * Adds a settlement job inside the trigger's transaction. A job already open
   * for the same (auction, kind, lot) is kept, so repeated triggers are no-ops.
   */
  async enqueue(
    tx: Tx | typeof db,
    input: {
      auctionId: number;
      kind: EmdSettlementJobKind;
      lotId?: number | null;
      paused?: boolean;
      createdBy?: number | null;
    },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO emd_settlement_jobs (auction_id, kind, lot_id, status, created_by)
      VALUES (${input.auctionId}, ${input.kind}, ${input.lotId ?? null},
              ${input.paused ? "paused" : "queued"}, ${input.createdBy ?? null})
      ON CONFLICT DO NOTHING
    `);
  }

  async enqueueClosed(tx: Tx | typeof db, auctionIds: number[], createdBy?: number | null): Promise<void> {
    for (const auctionId of auctionIds) {
      await this.enqueue(tx, { auctionId, kind: "auction_closed", createdBy });
    }
  }

  /** Puts jobs whose worker died mid-run back in the queue. */
  private async reclaimStuck(): Promise<number> {
    const res = await db.execute(sql`
      UPDATE emd_settlement_jobs
      SET status = 'queued', next_attempt_at = now(), updated_at = now()
      WHERE status = 'running'
        AND COALESCE(updated_at, started_at) < now() - (${env.EMD_SETTLEMENT_STUCK_MS} * interval '1 millisecond')
    `);
    return res.rowCount ?? 0;
  }

  private async claim(limit: number): Promise<ClaimedJob[]> {
    const res = await db.execute<ClaimedJob>(sql`
      UPDATE emd_settlement_jobs
      SET status = 'running', attempts = attempts + 1,
          started_at = now(), updated_at = now(), last_error = NULL
      WHERE id IN (
        SELECT id FROM emd_settlement_jobs
        WHERE status = 'queued' AND next_attempt_at <= now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, auction_id, kind, lot_id, attempts, created_by
    `);
    return res.rows;
  }

  /** One worker pass: reclaim stuck jobs, then settle claimed jobs one by one. */
  async tick(limit = 2): Promise<EmdSettlementTickResult> {
    await this.reclaimStuck();
    const jobs = await this.claim(limit);
    const result: EmdSettlementTickResult = { processed: 0, failed: 0, auctionIds: [] };
    for (const job of jobs) {
      try {
        await this.run(job);
        result.processed += 1;
        result.auctionIds.push(job.auction_id);
      } catch (err) {
        result.failed += 1;
        await this.markError(job, err);
      }
    }
    return result;
  }

  private async markError(job: ClaimedJob, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    const giveUp = job.attempts >= env.EMD_SETTLEMENT_MAX_ATTEMPTS;
    console.error(`emd settlement job ${job.id} (auction ${job.auction_id}) failed`, err);
    await db.execute(sql`
      UPDATE emd_settlement_jobs
      SET status = ${giveUp ? "failed" : "queued"},
          last_error = ${message},
          next_attempt_at = now() + (${backoffMinutes(job.attempts)} * interval '1 minute'),
          finished_at = ${giveUp ? sql`now()` : sql`NULL`},
          updated_at = now()
      WHERE id = ${job.id}
    `);
  }

  private async run(job: ClaimedJob): Promise<void> {
    const settlesWinning = SETTLES_WINNING.includes(job.kind);
    const ranges = settlesWinning ? await this.ranges(job.auction_id) : [];
    const userId = job.created_by ?? EMD_SYSTEM_USER_ID;
    let cursor = 0;
    for (;;) {
      const candidates = await this.candidates(job, cursor);
      if (candidates.length === 0) break;
      cursor = candidates[candidates.length - 1]!;
      await emdTransactionsService.run(async (tx) => {
        await emdTransactionsService.lockBidders(tx, candidates);
        await this.settleChunk(tx, job, candidates, ranges, settlesWinning, userId);
      });
    }

    await db.transaction(async (tx) => {
      if (settlesWinning) {
        await tx
          .update(auctions)
          .set({ emdSettledAt: sql`now()` })
          .where(eq(auctions.id, job.auction_id));
      }
      await tx.execute(sql`
        UPDATE emd_settlement_jobs
        SET status = 'done', finished_at = now(), updated_at = now()
        WHERE id = ${job.id}
      `);
    });
  }

  /**
   * The block a job works on. Close jobs settle everything blocked, held ranges
   * included, so a reopened lot's old winner is seen again. A withdrawn-lot job
   * only releases the block that is not held for a won range.
   */
  private blockSql(job: ClaimedJob, bidderIds: number[] | null): SQL {
    return job.kind === "lot_withdrawn"
      ? liveBlockOnAuctionSql(job.auction_id, bidderIds)
      : blockedOnAuctionSql(job.auction_id, bidderIds);
  }

  /** Next chunk of bidders that still hold a block on the auction. */
  private async candidates(job: ClaimedJob, afterBidderId: number): Promise<number[]> {
    const onlyWithdrawnLot =
      job.kind === "lot_withdrawn"
        ? sql`AND NOT EXISTS (
            SELECT 1 FROM auction_lot_bidder_maps m
            INNER JOIN auction_lots l
              ON l.auction_id = m.auction_id AND l.is_active
             AND (m.lot_id IS NULL OR m.lot_id = l.id)
            WHERE m.auction_id = ${job.auction_id}
              AND m.bidder_id = q.bidder_id
              AND m.is_active = true
          )`
        : sql``;
    const rows = await db.execute<{ bidder_id: number }>(sql`
      SELECT q.bidder_id FROM (${this.blockSql(job, null)}) q
      WHERE q.blocked > 0 AND q.bidder_id > ${afterBidderId}
      ${onlyWithdrawnLot}
      ORDER BY q.bidder_id
      LIMIT ${env.EMD_SETTLEMENT_BATCH}
    `);
    return rows.rows.map((r) => r.bidder_id);
  }

  private async ranges(auctionId: number): Promise<(SettlementRange & { label: string })[]> {
    const rows = await db.execute<{
      id: number;
      display_order: number | null;
      emd_amount: string;
      lot_display_order_from: string;
      lot_display_order_to: string;
    }>(sql`
      SELECT id, display_order, emd_amount, lot_display_order_from, lot_display_order_to
      FROM auction_lot_emd_ranges WHERE auction_id = ${auctionId}
    `);
    return rows.rows.map((r) => {
      const from = toAmount(r.lot_display_order_from);
      const to = toAmount(r.lot_display_order_to);
      return {
        id: r.id,
        displayOrder: r.display_order,
        emdAmount: toAmount(r.emd_amount),
        lotDisplayOrderFrom: from,
        lotDisplayOrderTo: to,
        label: emdRangeLabel(from, to),
      };
    });
  }

  private async settleChunk(
    tx: Tx,
    job: ClaimedJob,
    bidderIds: number[],
    ranges: SettlementRange[],
    settlesWinning: boolean,
    userId: number,
  ): Promise<void> {
    const blockedRows = await tx.execute<{ bidder_id: number; blocked: string }>(
      this.blockSql(job, bidderIds),
    );
    const blockedBy = new Map(blockedRows.rows.map((r) => [r.bidder_id, round2(toAmount(r.blocked))]));
    const idList = `{${bidderIds.join(",")}}`;

    const wonBy = new Map<number, SettlementWonLot[]>();
    const walletLotsBy = new Map<number, { lotId: number; displayOrder: number | null }[]>();
    const holdsBy = new Map<number, (typeof emdRangeHolds.$inferSelect)[]>();
    if (settlesWinning) {
      const won = await tx.execute<{
        id: number;
        winner_bidder_id: number;
        display_order: string | null;
      }>(sql`
        SELECT al.id, al.winner_bidder_id, al.display_order
        FROM auction_lots al
        JOIN auction_lot_bidder_maps m ON m.auction_id = al.auction_id
          AND m.bidder_id = al.winner_bidder_id AND m.lot_id = al.id AND m.is_active
        WHERE al.auction_id = ${job.auction_id} AND al.is_active
          AND al.winner_bidder_id = ANY(${idList}::int[])
          AND COALESCE(m.is_emd_with_client, false) = false
        ORDER BY al.display_order NULLS LAST, al.id
      `);
      for (const lot of won.rows) {
        const list = wonBy.get(lot.winner_bidder_id) ?? [];
        list.push({
          lotId: lot.id,
          displayOrder: lot.display_order == null ? null : toAmount(lot.display_order),
        });
        wonBy.set(lot.winner_bidder_id, list);
      }

      // Wallet-blocked lots per bidder (EMD not with the client), for the lots
      // shown on the release entry.
      const mapped = await tx.execute<{
        bidder_id: number;
        lot_id: number;
        display_order: string | null;
      }>(sql`
        SELECT m.bidder_id, l.id AS lot_id, l.display_order
        FROM auction_lot_bidder_maps m
        JOIN auction_lots l ON l.id = m.lot_id
        WHERE m.auction_id = ${job.auction_id} AND m.is_active
          AND COALESCE(m.is_emd_with_client, false) = false
          AND l.is_active
          AND m.bidder_id = ANY(${idList}::int[])
        ORDER BY l.display_order NULLS LAST, l.id
      `);
      for (const row of mapped.rows) {
        const list = walletLotsBy.get(row.bidder_id) ?? [];
        list.push({
          lotId: row.lot_id,
          displayOrder: row.display_order == null ? null : toAmount(row.display_order),
        });
        walletLotsBy.set(row.bidder_id, list);
      }

      const holds = await tx
        .select()
        .from(emdRangeHolds)
        .where(
          and(eq(emdRangeHolds.auctionId, job.auction_id), inArray(emdRangeHolds.bidderId, bidderIds)),
        );
      for (const h of holds) {
        const list = holdsBy.get(h.bidderId) ?? [];
        list.push(h);
        holdsBy.set(h.bidderId, list);
      }
    }

    const releaseType = RELEASE_TYPE[job.kind];
    const inputs: EmdPostInput[] = [];
    const releasedMaps: { bidderId: number; lotIds: number[] }[] = [];
    let settled = 0;
    let released = 0;
    let heldTotal = 0;
    for (const bidderId of bidderIds) {
      const blocked = blockedBy.get(bidderId) ?? 0;
      if (blocked <= 0) continue;
      const existing = holdsBy.get(bidderId) ?? [];
      const wonLots = wonBy.get(bidderId) ?? [];
      const plan = settlesWinning
        ? planCloseSettlement({
            blockedBalance: blocked,
            ranges,
            wonLots,
            consumedRangeIds: new Set(
              existing
                .filter((h) => toAmount(h.amountReleased) + toAmount(h.amountForfeited) > 0)
                .map((h) => h.emdRangeId),
            ),
          })
        : { holds: [], releaseAmount: blocked };

      // Make every range hold exactly what the bidder still wins.
      let changed = plan.releaseAmount > 0;
      if (settlesWinning) {
        const writes = holdWrites({
          targets: plan.holds,
          existing: existing.map((h) => ({
            emdRangeId: h.emdRangeId,
            amountReleased: toAmount(h.amountReleased),
            amountForfeited: toAmount(h.amountForfeited),
          })),
        });
        for (const w of writes) {
          const row = existing.find((h) => h.emdRangeId === w.emdRangeId);
          if (!row) {
            await tx.insert(emdRangeHolds).values({
              auctionId: job.auction_id,
              bidderId,
              emdRangeId: w.emdRangeId,
              amountHeld: w.amountHeld.toFixed(2),
              lotIds: w.lotIds,
            });
            changed = true;
            continue;
          }
          const same =
            toAmount(row.amountHeld) === w.amountHeld &&
            [...row.lotIds].sort().join() === [...w.lotIds].sort().join();
          if (same) continue;
          await tx
            .update(emdRangeHolds)
            .set({ amountHeld: w.amountHeld.toFixed(2), lotIds: w.lotIds, updatedAt: sql`now()` })
            .where(
              and(
                eq(emdRangeHolds.auctionId, job.auction_id),
                eq(emdRangeHolds.bidderId, bidderId),
                row.emdRangeId == null
                  ? isNull(emdRangeHolds.emdRangeId)
                  : eq(emdRangeHolds.emdRangeId, row.emdRangeId),
              ),
            );
          changed = true;
        }
      }
      heldTotal += plan.holds.reduce((sum, h) => sum + h.amount, 0);
      if (changed) settled += 1;

      if (plan.releaseAmount > 0) {
        // Lots whose money actually came back: not won, not in a range that
        // stays blocked, not client-held.
        const comebackLotIds = settlesWinning
          ? releasedLotIds(walletLotsBy.get(bidderId) ?? [], wonLots, plan.holds, ranges)
          : undefined;
        if (comebackLotIds) releasedMaps.push({ bidderId, lotIds: comebackLotIds });
        released += plan.releaseAmount;
        inputs.push({
          bidderId,
          emdType: releaseType,
          amount: plan.releaseAmount,
          auctionId: job.auction_id,
          blockLotIds: comebackLotIds,
          createdBy: userId,
        });
      }
    }

    if (inputs.length > 0) {
      await emdTransactionsService.postMany(tx, inputs, { allowOverdraw: true });
    }
    // Per-lot record of what came back, so a reopen can tell which lots need a
    // re-attach: the bidder stays mapped to them but cannot bid until then.
    for (const m of releasedMaps) {
      if (m.lotIds.length === 0) continue;
      await tx
        .update(auctionLotBidderMaps)
        .set({ emdReleased: true })
        .where(
          and(
            eq(auctionLotBidderMaps.auctionId, job.auction_id),
            eq(auctionLotBidderMaps.bidderId, m.bidderId),
            eq(auctionLotBidderMaps.isActive, true),
            inArray(auctionLotBidderMaps.lotId, m.lotIds),
          ),
        );
    }
    await tx.execute(sql`
      UPDATE emd_settlement_jobs
      SET bidders_settled = COALESCE(bidders_settled, 0) + ${settled},
          amount_released = COALESCE(amount_released, 0) + ${round2(released)},
          amount_winning = COALESCE(amount_winning, 0) + ${round2(heldTotal)},
          updated_at = now()
      WHERE id = ${job.id}
    `);
  }

  async list(filters: {
    statuses?: EmdSettlementJobStatus[];
    auctionId?: number;
    page: number;
    pageSize: number;
  }): Promise<{ items: EmdSettlementJobRow[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize, offset } = clampPagination(filters.page, filters.pageSize);
    const conds: (SQL | undefined)[] = [
      filters.statuses?.length ? inArray(emdSettlementJobs.status, filters.statuses) : undefined,
      filters.auctionId != null ? eq(emdSettlementJobs.auctionId, filters.auctionId) : undefined,
    ];
    const where = combineConditions(conds);
    const [[countRow], rows] = await Promise.all([
      db.select({ n: count() }).from(emdSettlementJobs).where(where),
      db
        .select({ job: emdSettlementJobs, auctionNumber: auctions.auctionNumber })
        .from(emdSettlementJobs)
        .leftJoin(auctions, eq(auctions.id, emdSettlementJobs.auctionId))
        .where(where)
        .orderBy(desc(emdSettlementJobs.id))
        .limit(pageSize)
        .offset(offset),
    ]);
    return {
      items: rows.map(({ job: j, auctionNumber }) => ({
        id: j.id,
        auctionId: j.auctionId,
        auctionNumber,
        kind: j.kind,
        lotId: j.lotId,
        status: j.status,
        attempts: j.attempts,
        lastError: j.lastError,
        biddersSettled: j.biddersSettled ?? 0,
        amountReleased: toAmount(j.amountReleased),
        amountHeld: toAmount(j.amountWinning),
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
      })),
      total: countRow?.n ?? 0,
      page,
      pageSize,
    };
  }

  /** Admin retry of a failed job. */
  async retry(jobId: number): Promise<void> {
    const res = await db
      .update(emdSettlementJobs)
      .set({ status: "queued", attempts: 0, nextAttemptAt: sql`now()`, finishedAt: null, updatedAt: sql`now()` })
      .where(and(eq(emdSettlementJobs.id, jobId), eq(emdSettlementJobs.status, "failed")))
      .returning({ id: emdSettlementJobs.id });
    if (res.length > 0) return;
    const [exists] = await db
      .select({ id: emdSettlementJobs.id })
      .from(emdSettlementJobs)
      .where(eq(emdSettlementJobs.id, jobId))
      .limit(1);
    if (!exists) throw EmdError.notFound(EmdErrorMessages.SETTLEMENT_JOB_NOT_FOUND);
    throw EmdError.conflict(EmdErrorMessages.SETTLEMENT_JOB_NOT_RETRYABLE);
  }

  /** Releases paused jobs (legacy cutover) into the queue; all when no ids given. */
  async resume(jobIds: number[] | null): Promise<number> {
    const res = await db
      .update(emdSettlementJobs)
      .set({ status: "queued", nextAttemptAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        combineConditions([
          eq(emdSettlementJobs.status, "paused"),
          jobIds?.length ? inArray(emdSettlementJobs.id, jobIds) : undefined,
        ]),
      )
      .returning({ id: emdSettlementJobs.id });
    return res.length;
  }
}

export const emdSettlementService = new EmdSettlementService();

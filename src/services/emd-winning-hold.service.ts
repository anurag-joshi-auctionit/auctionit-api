import { and, eq, isNull, sql } from "drizzle-orm";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { db } from "../db/index.js";
import { auctions, emdRangeHolds, type EmdRangeHold } from "../db/schema/index.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import { EmdError } from "../lib/emd/errors.js";
import {
  computeBidderEmdRequired,
  validateBlockRow,
  type EmdRangeWithDisplayOrder,
} from "../lib/emd/emd-required.js";
import {
  holdWrites,
  planCloseSettlement,
  type SettlementRange,
  type SettlementWonLot,
} from "../lib/emd/close-settlement.js";
import { AuctionValidationError } from "./auctions-errors.js";
import { emdTransactionsService, type Tx } from "./emd-transactions.service.js";

type Executor = Tx | typeof db;

export type WinningHoldTarget = {
  /** EMD required for the bidder's current won, non-client lots on this auction. */
  target: number;
  ranges: SettlementRange[];
  wonLots: SettlementWonLot[];
  uncoveredLotIds: number[];
};

async function loadRanges(executor: Executor, auctionId: number): Promise<SettlementRange[]> {
  const rows = await executor.execute<{
    id: number;
    display_order: number | null;
    emd_amount: string;
    lot_display_order_from: string;
    lot_display_order_to: string;
  }>(sql`
    SELECT id, display_order, emd_amount, lot_display_order_from, lot_display_order_to
    FROM auction_lot_emd_ranges WHERE auction_id = ${auctionId}
  `);
  return rows.rows.map((r) => ({
    id: r.id,
    displayOrder: r.display_order,
    emdAmount: toAmount(r.emd_amount),
    lotDisplayOrderFrom: toAmount(r.lot_display_order_from),
    lotDisplayOrderTo: toAmount(r.lot_display_order_to),
  }));
}

/**
 * The bidder's current won, active, non-"with client" lots on this auction,
 * plus `extraLotId` (for the preview's "what if they also won this lot" case)
 * when it isn't already among them.
 */
async function loadWonLots(
  executor: Executor,
  auctionId: number,
  bidderId: number,
  extraLotId?: number | null,
): Promise<SettlementWonLot[]> {
  const rows = await executor.execute<{ id: number; display_order: string | null }>(sql`
    SELECT al.id, al.display_order
    FROM auction_lots al
    JOIN auction_lot_bidder_maps m ON m.auction_id = al.auction_id
      AND m.bidder_id = al.winner_bidder_id AND m.lot_id = al.id AND m.is_active
    WHERE al.auction_id = ${auctionId} AND al.is_active
      AND al.winner_bidder_id = ${bidderId}
      AND COALESCE(m.is_emd_with_client, false) = false
    ORDER BY al.display_order NULLS LAST, al.id
  `);
  const wonLots = rows.rows.map((r) => ({
    lotId: r.id,
    displayOrder: r.display_order == null ? null : toAmount(r.display_order),
  }));
  if (extraLotId != null && !wonLots.some((l) => l.lotId === extraLotId)) {
    const extra = await executor.execute<{ id: number; display_order: string | null }>(sql`
      SELECT id, display_order FROM auction_lots
      WHERE id = ${extraLotId} AND auction_id = ${auctionId} AND is_active
      LIMIT 1
    `);
    const row = extra.rows[0];
    if (row) {
      wonLots.push({
        lotId: row.id,
        displayOrder: row.display_order == null ? null : toAmount(row.display_order),
      });
    }
  }
  return wonLots;
}

async function loadConsolidatedEmd(executor: Executor, auctionId: number): Promise<number | null> {
  const [row] = await executor
    .select({ consolidatedEmdAmount: auctions.consolidatedEmdAmount })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);
  return row?.consolidatedEmdAmount == null ? null : toAmount(row.consolidatedEmdAmount);
}

/**
 * The EMD a bidder must hold for their *current* won, non-client lots on an
 * auction — the post-close equivalent of `computeBidderEmdRequired`, shared by
 * the correction's wallet reconciliation and its read-only preview endpoint so
 * the two can never disagree. Zero won lots always means zero required,
 * regardless of any consolidated ceiling (unlike `computeBidderEmdRequired`'s
 * own no-ranges fallback, written for "at least one lot is being requested").
 */
export async function computeWinningHoldTarget(
  executor: Executor,
  input: { auctionId: number; bidderId: number; extraLotId?: number | null },
): Promise<WinningHoldTarget> {
  const [ranges, wonLots, consolidatedEmd] = await Promise.all([
    loadRanges(executor, input.auctionId),
    loadWonLots(executor, input.auctionId, input.bidderId, input.extraLotId),
    loadConsolidatedEmd(executor, input.auctionId),
  ]);

  if (wonLots.length === 0) {
    return { target: 0, ranges, wonLots, uncoveredLotIds: [] };
  }

  const rangesWithOrder: EmdRangeWithDisplayOrder[] = ranges;
  const { emdRequired, uncoveredLotIds } = computeBidderEmdRequired({
    selectedLots: wonLots,
    ranges: rangesWithOrder,
    consolidatedEmd,
  });

  return { target: emdRequired, ranges, wonLots, uncoveredLotIds };
}

/** Sum of a bidder's still-held `emd_range_holds` rows on one auction. */
export async function currentWinningHoldTotal(
  executor: Executor,
  auctionId: number,
  bidderId: number,
): Promise<{ holds: EmdRangeHold[]; total: number }> {
  const holds = await executor
    .select()
    .from(emdRangeHolds)
    .where(and(eq(emdRangeHolds.auctionId, auctionId), eq(emdRangeHolds.bidderId, bidderId)));
  const total = round2(
    holds.reduce(
      (sum, h) => sum + toAmount(h.amountHeld) - toAmount(h.amountReleased) - toAmount(h.amountForfeited),
      0,
    ),
  );
  return { holds, total };
}

export type ReconcileWinningHoldInput = {
  auctionId: number;
  bidderId: number;
  userId: number;
};

/**
 * Reconciles one bidder's held EMD for an auction to match their *current*
 * won, non-client lot set. Called for both sides of a winner correction: the
 * old winner (who can only lose held EMD here, so this can never throw) and
 * the new winner (who may need a fresh wallet block, so this is the side that
 * can fail on insufficient balance). Must run after the correction's own SQL
 * has already updated `auction_lots.winner_bidder_id` / `auction_lot_bidder_maps`,
 * since the won-lot query here reads the post-correction state.
 *
 * The balance check (`validateBlockRow`, backed by `emdTransactionsService`'s
 * own ledger guard) always reads the bidder's live available balance inside
 * this locked transaction — never a snapshot tied to the auction's close date
 * — so a correction run weeks after close is checked against the wallet as it
 * stands at the moment the correction runs, not at close time.
 */
export async function reconcileWinningHoldForCorrection(
  tx: Tx,
  input: ReconcileWinningHoldInput,
): Promise<void> {
  const { auctionId, bidderId, userId } = input;
  await emdTransactionsService.lockBidders(tx, [bidderId]);

  const { target, ranges, wonLots, uncoveredLotIds } = await computeWinningHoldTarget(tx, {
    auctionId,
    bidderId,
  });
  if (uncoveredLotIds.length > 0) {
    throw new AuctionValidationError(AuctionsValidationMessages.CORRECTION_EMD_RANGE_MISCONFIGURED);
  }

  const { holds: existingHolds, total: heldTotal } = await currentWinningHoldTotal(tx, auctionId, bidderId);
  const delta = round2(target - heldTotal);

  if (delta > 0) {
    const available = await emdTransactionsService.availableBalance(tx, bidderId);
    const error = validateBlockRow({
      isEmdWithClient: false,
      emdRequired: delta,
      emdAvailable: available,
    });
    if (error) throw new AuctionValidationError(error, { isEmdWithClient: [error] });
  }

  const plan = planCloseSettlement({
    blockedBalance: target,
    ranges,
    wonLots,
    consumedRangeIds: new Set(
      existingHolds
        .filter((h) => toAmount(h.amountReleased) + toAmount(h.amountForfeited) > 0)
        .map((h) => h.emdRangeId),
    ),
  });

  if (delta !== 0) {
    const winningLotIds = plan.holds.flatMap((h) => h.lotIds);
    try {
      await emdTransactionsService.postMany(tx, [
        {
          bidderId,
          emdType: delta > 0 ? "blocked_winning_correction" : "release_winning_correction",
          amount: Math.abs(delta),
          auctionId,
          winningLotIds,
          createdBy: userId,
        },
      ]);
    } catch (err) {
      if (err instanceof EmdError) {
        throw new AuctionValidationError(err.message, { isEmdWithClient: [err.message] });
      }
      throw err;
    }
  }

  const writes = holdWrites({
    targets: plan.holds,
    existing: existingHolds.map((h) => ({
      emdRangeId: h.emdRangeId,
      amountReleased: toAmount(h.amountReleased),
      amountForfeited: toAmount(h.amountForfeited),
    })),
  });
  for (const w of writes) {
    const row = existingHolds.find((h) => h.emdRangeId === w.emdRangeId);
    if (!row) {
      await tx.insert(emdRangeHolds).values({
        auctionId,
        bidderId,
        emdRangeId: w.emdRangeId,
        amountHeld: w.amountHeld.toFixed(2),
        lotIds: w.lotIds,
      });
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
          eq(emdRangeHolds.auctionId, auctionId),
          eq(emdRangeHolds.bidderId, bidderId),
          row.emdRangeId == null ? isNull(emdRangeHolds.emdRangeId) : eq(emdRangeHolds.emdRangeId, row.emdRangeId),
        ),
      );
  }
}

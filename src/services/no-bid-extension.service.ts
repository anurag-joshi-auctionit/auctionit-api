import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  NO_BID_EXTENSION_LEAD_SEC,
  NO_BID_EXTENSION_STALENESS_GUARD_SEC,
} from "../lib/auctions/no-bid-extension.js";
import { CLOSE_LOCK_KEY, closeEndedLots } from "./auction-close.service.js";
import { applyCascadeFromAnchor } from "./lot-stagger.service.js";

export type ExtendedLot = {
  lotId: number;
  auctionId: number;
  oldEndsAt: string;
  newEndsAt: string;
  extendedBySec: number;
};

export type NoBidExtensionTickResult = {
  /** Lots whose end time moved because they had no bid. */
  extended: ExtendedLot[];
  /** Lots dragged along by client lot-staggering (sequential chain). */
  staggered: ExtendedLot[];
  /** Auctions touched by either — callers re-broadcast these. */
  auctionIds: number[];
  /** Auctions auto-closed this tick, evaluated after any extension above. */
  closedAuctionIds: number[];
  /** False when another instance held the lock and this tick did nothing. */
  ran: boolean;
};

type BumpedRow = {
  lot_id: number;
  auction_id: number;
  client_id: number;
  display_order: string | null;
  old_end: string;
  new_end: string;
  /** Pre-extension end — retained for audit / debugging. */
  old_end_ms: string;
  /** Post-extension end — cascade chain starts from this. */
  new_end_ms: string;
  interval_seconds: number;
  is_staggered: boolean | null;
  stagger_interval: number | null;
};

/**
 * A lot's effective end instant: extension override when set (timestamptz), else
 * auction calendar day + scheduled end_time interpreted as Asia/Kolkata.
 */
const EFFECTIVE_END = sql`COALESCE(
  l.extended_end_time,
  (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'
)`;

/**
 * True when a lot (aliased `l`, its auction `a`) is still a no-bid-extension
 * candidate right now — i.e. the next tick's `bumpNoBidLots` would keep it
 * open, directly or by dragging it along via the stagger cascade. Mirrors
 * `bumpNoBidLots`'s WHERE clause minus the stagger rank tie-break: a lot with
 * no bid that's within the window is never actually closed next tick either
 * way, so the tie-break (which specific lot is the direct bump anchor)
 * doesn't matter for "is this lot closed" callers.
 *
 * Exported so every place that reports a lot as "closed" for live display —
 * not just this service's own auto-close step — agrees with the tick's
 * decision instead of racing a 2s-cadence timer with a raw timestamp
 * comparison. See live-auction.service.ts and auctions-pg.service.ts.
 */
export const NO_BID_EXTENSION_PENDING = sql`(
  l.is_active AND a.is_active AND a.status = 'published'
  AND l.is_no_bid_extension AND NOT l.is_reopened
  AND COALESCE(a.is_no_bid_extension, true)
  AND COALESCE(a.no_bid_extension_interval, 0) > 0
  AND l.no_bid_extension_count < COALESCE(a.no_bid_extension_count_max, 0)
  AND COALESCE(l.winner_user_id, 0) = 0
  AND l.bid_count = 0
  AND (${EFFECTIVE_END}) >= now() - make_interval(secs => ${NO_BID_EXTENSION_STALENESS_GUARD_SEC})
)`;

/**
 * Port of legacy `usp_PushUpdate` — pushes out the end time of live lots that
 * have attracted no bid, then adds stagger interval onto later lots' current
 * ends (stagger alone — not no-bid interval + stagger). Then, in the SAME
 * transaction, resolves auto-close: a lot just extended above reads its own
 * fresh extended_end_time, so it can never be swept into "closed" in the
 * same breath it was kept open. This ordering — extend first, close only if
 * nothing triggered — is the whole point of merging the two here instead of
 * running them as separate, uncoordinated timers.
 *
 * When lot-staggering is enabled, only the earliest open lot per auction at
 * its effective end is no-bid-bumped; siblings move via stagger.
 *
 * Runs on a timer (see index.ts) rather than per-request: a lot has to extend
 * (or close) whether or not anyone is watching it.
 */
export class NoBidExtensionService {
  /**
   * @param leadSec Clock-skew epsilon for the no-bid check.
   * @param noBidEnabled Set false (env.NO_BID_EXTENSION_ENABLED off) to skip
   *   the no-bid step and go straight to closeEndedLots — auto-close has no
   *   feature flag of its own and must keep running regardless.
   */
  async tick(
    leadSec: number = NO_BID_EXTENSION_LEAD_SEC,
    noBidEnabled = true,
  ): Promise<NoBidExtensionTickResult> {
    return db.transaction(async (tx) => {
      const empty: NoBidExtensionTickResult = {
        extended: [],
        staggered: [],
        auctionIds: [],
        closedAuctionIds: [],
        ran: false,
      };

      // Shared with pgReopenLots (auctions-pg.service.ts), which takes this
      // same advisory lock so a reopen can never land mid-resolution.
      const lock = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${CLOSE_LOCK_KEY}) AS locked`,
      );
      if (!lock.rows[0]?.locked) return empty;

      const bumped = noBidEnabled ? await this.bumpNoBidLots(tx, leadSec) : [];

      const extended: ExtendedLot[] = bumped.map((r) => ({
        lotId: r.lot_id,
        auctionId: r.auction_id,
        oldEndsAt: r.old_end,
        newEndsAt: r.new_end,
        extendedBySec: r.interval_seconds,
      }));
      if (extended.length > 0) {
        await this.audit(tx, extended, "no_bid");
      }

      // No-bid first, then chain subsequent lots from the post-extension end.
      const staggered: ExtendedLot[] = [];
      for (const row of bumped) {
        const enabled = row.is_staggered === true;
        const intervalSec = row.stagger_interval ?? 0;
        const moved = await applyCascadeFromAnchor(tx, {
          auctionId: row.auction_id,
          anchorLotId: row.lot_id,
          anchorEndMs: Number(row.new_end_ms),
          enabled,
          intervalSec,
        });
        staggered.push(...moved);
      }

      // Only now, after every eligible lot has had its chance to extend,
      // decide which auctions have truly run out of open lots.
      const closedAuctionIds = await closeEndedLots(tx);

      const auctionIds = [
        ...new Set([...extended, ...staggered].map((r) => r.auctionId)),
      ];
      return {
        extended,
        staggered,
        auctionIds,
        closedAuctionIds,
        ran: true,
      };
    });
  }

  /**
   * The core update. Candidates are gated in SQL so Postgres re-checks against
   * the latest row version if a bid lands concurrently. When lot-staggering is
   * on, only the chronologically earliest open lot per auction in the lead
   * window (effective end, then display_order, then id) is bumped — later lots
   * move via stagger alone, not no-bid + stagger.
   */
  private async bumpNoBidLots(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    leadSec: number,
  ): Promise<BumpedRow[]> {
    const res = await tx.execute<BumpedRow>(sql`
      WITH candidates AS (
        SELECT
          l.id AS lot_id,
          l.auction_id,
          ROW_NUMBER() OVER (
            PARTITION BY l.auction_id
            ORDER BY (${EFFECTIVE_END}) ASC,
                     l.display_order NULLS LAST,
                     l.id
          ) AS rn,
          COALESCE(a.is_staggered, c.is_staggered, false) AS is_staggered,
          COALESCE(c.stagger_interval, 0) AS stagger_interval
        FROM auction_lots l
        JOIN auctions a ON a.auction_id = l.auction_id
        JOIN clients c ON c.id = a.client_id
        WHERE l.is_active
          AND a.is_active
          AND a.status = 'published'
          AND l.is_no_bid_extension
          -- Reopened lots get no extensions (and don't rank as the stagger anchor).
          AND NOT l.is_reopened
          AND COALESCE(a.is_no_bid_extension, true)
          AND COALESCE(a.no_bid_extension_interval, 0) > 0
          AND l.no_bid_extension_count < COALESCE(a.no_bid_extension_count_max, 0)
          AND COALESCE(l.winner_user_id, 0) = 0
          AND l.bid_count = 0
          AND l.start_time IS NOT NULL
          AND l.end_time IS NOT NULL
          AND ((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') <= now()
          -- Evaluate at/just past the effective end (within the clock-skew
          -- epsilon), not a pre-emptive lookahead band; the staleness guard
          -- only tolerates a missed tick, it never widens the window early.
          AND (${EFFECTIVE_END})
                >= now() - make_interval(secs => ${NO_BID_EXTENSION_STALENESS_GUARD_SEC})
          AND (${EFFECTIVE_END})
                <= now() + make_interval(secs => ${leadSec})
      ),
      to_bump AS (
        SELECT lot_id
        FROM candidates
        WHERE is_staggered = false
           OR stagger_interval <= 0
           OR rn = 1
      )
      UPDATE auction_lots l
      SET extended_end_time = ${EFFECTIVE_END} + make_interval(secs => a.no_bid_extension_interval),
          no_bid_extension_count = l.no_bid_extension_count + 1,
          live_rev = l.live_rev + 1,
          updated_at = now()
      FROM auctions a
      JOIN clients c ON c.id = a.client_id
      WHERE a.auction_id = l.auction_id
        AND l.id IN (SELECT lot_id FROM to_bump)
        -- Re-check gates against the latest row (bid may have landed mid-tick).
        AND l.is_active
        AND a.is_active
        AND a.status = 'published'
        AND l.is_no_bid_extension
        AND NOT l.is_reopened
        AND COALESCE(a.is_no_bid_extension, true)
        AND COALESCE(a.no_bid_extension_interval, 0) > 0
        AND l.no_bid_extension_count < COALESCE(a.no_bid_extension_count_max, 0)
        AND COALESCE(l.winner_user_id, 0) = 0
        AND l.bid_count = 0
        AND l.start_time IS NOT NULL
        AND l.end_time IS NOT NULL
        AND ((a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') <= now()
        AND (${EFFECTIVE_END})
              >= now() - make_interval(secs => ${NO_BID_EXTENSION_STALENESS_GUARD_SEC})
        AND (${EFFECTIVE_END})
              <= now() + make_interval(secs => ${leadSec})
      RETURNING
        l.id AS lot_id,
        l.auction_id,
        l.client_id,
        l.display_order,
        to_char(l.extended_end_time - make_interval(secs => a.no_bid_extension_interval),
                'YYYY-MM-DD"T"HH24:MI:SS') AS old_end,
        to_char(l.extended_end_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS new_end,
        (EXTRACT(EPOCH FROM (
          l.extended_end_time - make_interval(secs => a.no_bid_extension_interval)
        )) * 1000)::bigint::text AS old_end_ms,
        (EXTRACT(EPOCH FROM l.extended_end_time) * 1000)::bigint::text AS new_end_ms,
        a.no_bid_extension_interval AS interval_seconds,
        COALESCE(a.is_staggered, c.is_staggered) AS is_staggered,
        c.stagger_interval
    `);
    return res.rows;
  }

  private async audit(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    rows: ExtendedLot[],
    reason: "no_bid" | "stagger",
  ): Promise<void> {
    if (rows.length === 0) return;
    const values = sql.join(
      rows.map(
        (r) =>
          sql`(${r.auctionId}, ${r.lotId}, ${r.oldEndsAt}::timestamp, ${r.newEndsAt}::timestamp, ${r.extendedBySec}, NULL, ${reason}::lot_extension_reason)`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      INSERT INTO auction_lot_extensions
        (auction_id, lot_id, old_ends_at, new_ends_at, extended_by_sec, triggered_by_bidder_id, reason)
      VALUES ${values}
    `);
  }
}

export const noBidExtensionService = new NoBidExtensionService();

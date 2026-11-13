import { sql, type SQL } from "drizzle-orm";
import { db, pool } from "./index.js";
import { blockedByAuctionSql, refreshBalanceCachesSql } from "../lib/emd/blocked.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import {
  holdWrites,
  planCloseSettlement,
  type SettlementRange,
  type SettlementWonLot,
} from "../lib/emd/close-settlement.js";

/**
 * One-off, safe to re-run. Before this fix, a won lot whose EMD is with the
 * client (`auction_lot_bidder_maps.is_emd_with_client`) still counted as
 * "won" when a close allocated the blocked balance across EMD ranges, so a
 * range whose only won lot was with-client got held money it was never
 * blocked for, at another range's expense. This recomputes every (auction,
 * bidder) whose current `emd_range_holds.lot_ids` includes a with-client lot
 * the same way `settleChunk` now does with with-client lots excluded, and
 * rewrites the holds to match. The ledger (`emd_transactions`) is not
 * touched: the total blocked balance does not change, only how it is split
 * across ranges and which lots a hold lists.
 *
 * Dry run by default: pass --apply to write.
 *
 * Run when / applies to / retire when: docs/ops/emd-one-off-scripts.md
 */
const apply = process.argv.includes("--apply");

type HoldRow = {
  id: number;
  emd_range_id: number | null;
  amount_held: string;
  amount_released: string;
  amount_forfeited: string;
  lot_ids: number[];
};

function lotIdsArraySql(ids: number[]): SQL {
  return ids.length === 0
    ? sql`ARRAY[]::int[]`
    : sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[]`;
}

async function main() {
  const affected = (
    await db.execute(sql`
      SELECT DISTINCT h.auction_id, h.bidder_id
      FROM emd_range_holds h
      JOIN auction_lot_bidder_maps m ON m.auction_id = h.auction_id AND m.bidder_id = h.bidder_id
        AND m.lot_id = ANY(h.lot_ids) AND m.is_emd_with_client = true
      ORDER BY h.auction_id, h.bidder_id`)
  ).rows as unknown as { auction_id: number; bidder_id: number }[];

  let changed = 0;
  let unchanged = 0;
  for (const { auction_id: auctionId, bidder_id: bidderId } of affected) {
    const rangeRows = (
      await db.execute(sql`
        SELECT id, display_order, emd_amount, lot_display_order_from, lot_display_order_to
        FROM auction_lot_emd_ranges WHERE auction_id = ${auctionId}`)
    ).rows as Array<Record<string, string | number | null>>;
    const ranges: SettlementRange[] = rangeRows.map((r) => ({
      id: Number(r.id),
      displayOrder: r.display_order == null ? null : Number(r.display_order),
      emdAmount: toAmount(String(r.emd_amount)),
      lotDisplayOrderFrom: Number(r.lot_display_order_from),
      lotDisplayOrderTo: Number(r.lot_display_order_to),
    }));

    const wonRows = (
      await db.execute(sql`
        SELECT al.id, al.display_order
        FROM auction_lots al
        JOIN auction_lot_bidder_maps m ON m.auction_id = al.auction_id
          AND m.bidder_id = al.winner_bidder_id AND m.lot_id = al.id AND m.is_active
        WHERE al.auction_id = ${auctionId} AND al.is_active
          AND al.winner_bidder_id = ${bidderId}
          AND COALESCE(m.is_emd_with_client, false) = false
        ORDER BY al.display_order NULLS LAST, al.id`)
    ).rows as Array<{ id: number; display_order: string | null }>;
    const wonLots: SettlementWonLot[] = wonRows.map((l) => ({
      lotId: l.id,
      displayOrder: l.display_order == null ? null : toAmount(l.display_order),
    }));

    const blockedRows = (
      await db.execute(
        sql`SELECT * FROM (${blockedByAuctionSql([bidderId])}) q WHERE q.auction_id = ${auctionId}`,
      )
    ).rows as Array<{ bidder_id: number; auction_id: number; blocked: string }>;
    const blocked = round2(Math.max(toAmount(blockedRows[0]?.blocked ?? "0"), 0));

    const existing = (
      await db.execute(sql`
        SELECT id, emd_range_id, amount_held, amount_released, amount_forfeited, lot_ids
        FROM emd_range_holds WHERE auction_id = ${auctionId} AND bidder_id = ${bidderId}`)
    ).rows as unknown as HoldRow[];

    const plan = planCloseSettlement({
      blockedBalance: blocked,
      ranges,
      wonLots,
      consumedRangeIds: new Set(
        existing
          .filter((h) => toAmount(h.amount_released) + toAmount(h.amount_forfeited) > 0)
          .map((h) => h.emd_range_id),
      ),
    });

    const writes = holdWrites({
      targets: plan.holds,
      existing: existing.map((h) => ({
        emdRangeId: h.emd_range_id,
        amountReleased: toAmount(h.amount_released),
        amountForfeited: toAmount(h.amount_forfeited),
      })),
    });

    for (const w of writes) {
      const row = existing.find((h) => h.emd_range_id === w.emdRangeId);
      const same =
        row != null &&
        toAmount(row.amount_held) === w.amountHeld &&
        [...row.lot_ids].sort().join() === [...w.lotIds].sort().join();
      if (same) {
        unchanged++;
        continue;
      }
      changed++;
      console.log(
        `auction ${auctionId} bidder ${bidderId} range ${w.emdRangeId}: ` +
          `${row ? `${toAmount(row.amount_held)} [${row.lot_ids}]` : "(none)"} -> ${w.amountHeld} [${w.lotIds}]`,
      );
      if (!apply) continue;
      if (!row) {
        await db.execute(sql`
          INSERT INTO emd_range_holds (auction_id, bidder_id, emd_range_id, amount_held, lot_ids)
          VALUES (${auctionId}, ${bidderId}, ${w.emdRangeId}, ${w.amountHeld}, ${lotIdsArraySql(w.lotIds)})`);
        continue;
      }
      await db.execute(sql`
        UPDATE emd_range_holds
        SET amount_held = ${w.amountHeld}, lot_ids = ${lotIdsArraySql(w.lotIds)}, updated_at = now()
        WHERE id = ${row.id}`);
    }
  }

  console.log(
    `${apply ? "changed" : "would change"} ${changed} hold(s), ${unchanged} already correct, ` +
      `across ${affected.length} (auction, bidder) pair(s)`,
  );
  if (apply) {
    const refreshed = await db.execute(refreshBalanceCachesSql(null));
    console.log(`emd balances rebuilt for ${refreshed.rowCount ?? 0} bidders`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

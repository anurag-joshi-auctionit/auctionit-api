import { sql } from "drizzle-orm";
import { db, pool } from "./index.js";
import { refreshBalanceCachesSql } from "../lib/emd/blocked.js";
import { splitNullRangeHold } from "../lib/emd/split-null-range-hold.js";

/**
 * One-off, safe to re-run. Legacy closes left `emd_range_holds` rows with no
 * `emd_range_id`, so a bidder who won lots in several EMD ranges has one hold
 * for all of them and a lifting release cannot credit a range on its own. This
 * splits each such hold into one row per won range, allocated as a close would
 * (EMD display order, capped by the held amount). Holds with releases or
 * forfeitures, lots already recorded as released, lots outside every range, or ranges that do not add up to the
 * held amount are listed and left alone. The ledger is not touched.
 *
 * Dry run by default: pass --apply to write.
 *
 * Run when / applies to / retire when: docs/ops/emd-one-off-scripts.md
 */
const apply = process.argv.includes("--apply");

type HoldRow = {
  id: number;
  auction_id: number;
  bidder_id: number;
  amount_held: string;
  amount_released: string;
  amount_forfeited: string;
  lot_ids: number[];
};

async function main() {
  const holds = (
    await db.execute(sql`
      SELECT h.id, h.auction_id, h.bidder_id, h.amount_held, h.amount_released, h.amount_forfeited, h.lot_ids
      FROM emd_range_holds h
      WHERE h.emd_range_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM emd_winning_lot_releases r
          WHERE r.bidder_id = h.bidder_id AND r.lot_id = ANY(h.lot_ids))
      ORDER BY h.id`)
  ).rows as unknown as HoldRow[];

  let split = 0;
  let skipped = 0;
  for (const h of holds) {
    const ranges = (
      await db.execute(sql`
        SELECT id, display_order, emd_amount, lot_display_order_from, lot_display_order_to
        FROM auction_lot_emd_ranges WHERE auction_id = ${h.auction_id}`)
    ).rows as Array<Record<string, string | number | null>>;
    const lots = (
      await db.execute(sql`
        SELECT id, display_order FROM auction_lots
        WHERE auction_id = ${h.auction_id} AND id IN (SELECT unnest(lot_ids) FROM emd_range_holds WHERE id = ${h.id})`)
    ).rows as Array<Record<string, string | number | null>>;

    const targets = splitNullRangeHold({
      amountHeld: Number(h.amount_held),
      amountReleased: Number(h.amount_released),
      amountForfeited: Number(h.amount_forfeited),
      ranges: ranges.map((r) => ({
        id: Number(r.id),
        displayOrder: r.display_order == null ? null : Number(r.display_order),
        emdAmount: Number(r.emd_amount),
        lotDisplayOrderFrom: Number(r.lot_display_order_from),
        lotDisplayOrderTo: Number(r.lot_display_order_to),
      })),
      wonLots: lots.map((l) => ({
        lotId: Number(l.id),
        displayOrder: l.display_order == null ? null : Number(l.display_order),
      })),
    });
    if (!targets) {
      skipped++;
      continue;
    }
    console.log(
      `hold ${h.id} (auction ${h.auction_id}, bidder ${h.bidder_id}) -> ` +
        targets.map((t) => `range ${t.emdRangeId}: ${t.amount} lots [${t.lotIds}]`).join("; "),
    );
    split++;
    if (!apply) continue;
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM emd_range_holds WHERE id = ${h.id}`);
      for (const t of targets) {
        await tx.execute(sql`
          INSERT INTO emd_range_holds
            (auction_id, bidder_id, emd_range_id, amount_held, lot_ids)
          VALUES (${h.auction_id}, ${h.bidder_id}, ${t.emdRangeId}, ${t.amount}, ARRAY[${sql.join(t.lotIds.map((id) => sql`${id}`), sql`, `)}]::int[])`);
      }
    });
  }
  console.log(`${apply ? "split" : "would split"} ${split}, skipped ${skipped} of ${holds.length} null-range holds`);
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

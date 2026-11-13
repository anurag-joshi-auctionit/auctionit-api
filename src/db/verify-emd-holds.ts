import { sql } from "drizzle-orm";
import { db, pool } from "./index.js";
import { blockedByAuctionSql } from "../lib/emd/blocked.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import { splitNullRangeHold } from "../lib/emd/split-null-range-hold.js";

/**
 * Read-only. Checks `emd_range_holds` and names the repair script for each
 * finding. Exits 1 when any check fails, so `seed.sh` stops on it.
 *
 *   1. a range-less hold that can be split per range  -> emd:split-null-range-holds
 *   2. money still held but every lot already released -> emd:credit-released-holds
 *   3. a lot release recorded before the bidder's latest win on that auction
 *      (a reopen and re-close), so the lot is hidden from the Release dialog
 *      while its money is held; only legacy Winning-model data  -> decide per case
 *   4. holds of a closed, settled auction that do not add up to the ledger's blocked
 *      amount                                           -> emd:rebuild-balances, then investigate
 *   5. a hold whose lot_ids include a lot the bidder has EMD with the client
 *      on (never actually blocked)                      -> emd:recompute-with-client-holds
 */
type Finding = { check: string; fix: string; detail: string };

async function main() {
  const findings: Finding[] = [];
  const rows = async <T>(q: ReturnType<typeof sql>) =>
    (await db.execute(q)).rows as unknown as T[];

  const nullHolds = await rows<{
    id: number; auction_id: number; bidder_id: number; amount_held: string;
    amount_released: string; amount_forfeited: string; lot_ids: number[];
  }>(sql`
    SELECT id, auction_id, bidder_id, amount_held, amount_released, amount_forfeited, lot_ids
    FROM emd_range_holds h
    WHERE emd_range_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM emd_winning_lot_releases r
                      WHERE r.bidder_id = h.bidder_id AND r.lot_id = ANY(h.lot_ids))`);
  for (const h of nullHolds) {
    const ranges = await rows<Record<string, string | number | null>>(sql`
      SELECT id, display_order, emd_amount, lot_display_order_from, lot_display_order_to
      FROM auction_lot_emd_ranges WHERE auction_id = ${h.auction_id}`);
    const lots = await rows<Record<string, string | number | null>>(sql`
      SELECT id, display_order FROM auction_lots
      WHERE auction_id = ${h.auction_id}
        AND id IN (SELECT unnest(lot_ids) FROM emd_range_holds WHERE id = ${h.id})`);
    const split = splitNullRangeHold({
      amountHeld: toAmount(h.amount_held),
      amountReleased: toAmount(h.amount_released),
      amountForfeited: toAmount(h.amount_forfeited),
      ranges: ranges.map((r) => ({
        id: Number(r.id),
        displayOrder: r.display_order == null ? null : Number(r.display_order),
        emdAmount: toAmount(String(r.emd_amount)),
        lotDisplayOrderFrom: Number(r.lot_display_order_from),
        lotDisplayOrderTo: Number(r.lot_display_order_to),
      })),
      wonLots: lots.map((l) => ({
        lotId: Number(l.id),
        displayOrder: l.display_order == null ? null : Number(l.display_order),
      })),
    });
    if (split) {
      findings.push({
        check: "splittable range-less hold",
        fix: "emd:split-null-range-holds",
        detail: `hold ${h.id} auction ${h.auction_id} bidder ${h.bidder_id}`,
      });
    }
  }

  for (const r of await rows<{ id: number; auction_id: number; bidder_id: number; remaining: string }>(sql`
    SELECT h.id, h.auction_id, h.bidder_id,
           (h.amount_held - h.amount_released - h.amount_forfeited)::text AS remaining
    FROM emd_range_holds h
    WHERE h.amount_held - h.amount_released - h.amount_forfeited > 0
      AND cardinality(h.lot_ids) > 0
      AND NOT EXISTS (SELECT 1 FROM unnest(h.lot_ids) l(id)
                      WHERE NOT EXISTS (SELECT 1 FROM emd_winning_lot_releases r
                                        WHERE r.bidder_id = h.bidder_id AND r.lot_id = l.id))
      AND NOT EXISTS (SELECT 1 FROM emd_forfeitures f
                      WHERE f.auction_id = h.auction_id AND f.bidder_id = h.bidder_id
                        AND f.emd_range_id IS NOT DISTINCT FROM h.emd_range_id AND f.status <> 'rejected')`)) {
    findings.push({
      check: "money held but every lot released",
      fix: "emd:credit-released-holds --apply --hold <id>, only if the hold is NOT also listed under stale lot release",
      detail: `hold ${r.id} auction ${r.auction_id} bidder ${r.bidder_id} remaining ${r.remaining}`,
    });
  }

  for (const r of await rows<{ id: number; auction_id: number; bidder_id: number; lot_id: number }>(sql`
    SELECT DISTINCT h.id, h.auction_id, h.bidder_id, r.lot_id
    FROM emd_range_holds h
    JOIN emd_winning_lot_releases r ON r.bidder_id = h.bidder_id AND r.lot_id = ANY(h.lot_ids)
    WHERE h.amount_held - h.amount_released - h.amount_forfeited > 0
      AND r.created_at < (SELECT max(t.created_at) FROM emd_transactions t
                          WHERE t.auction_id = h.auction_id AND t.bidder_id = h.bidder_id
                            AND t.emd_type = 'blocked_winning')`)) {
    findings.push({
      check: "stale lot release after reopen",
      fix: "legacy data from before the holds model: decide per case, do not credit automatically",
      detail: `hold ${r.id} auction ${r.auction_id} bidder ${r.bidder_id} lot ${r.lot_id}`,
    });
  }

  const ledger = await rows<{ bidder_id: number; auction_id: number; blocked: string }>(
    sql`SELECT * FROM (${blockedByAuctionSql(null)}) q
        WHERE q.auction_id IN (SELECT auction_id FROM auctions
                                WHERE status = 'closed' AND emd_settled_at IS NOT NULL)`,
  );
  const held = new Map(
    (
      await rows<{ bidder_id: number; auction_id: number; remaining: string }>(sql`
        SELECT bidder_id, auction_id,
               SUM(amount_held - amount_released - amount_forfeited)::text AS remaining
        FROM emd_range_holds GROUP BY bidder_id, auction_id`)
    ).map((r) => [`${r.auction_id}:${r.bidder_id}`, round2(toAmount(r.remaining))]),
  );
  const seen = new Set<string>();
  for (const l of ledger) {
    const key = `${l.auction_id}:${l.bidder_id}`;
    seen.add(key);
    const blocked = Math.max(round2(toAmount(l.blocked)), 0);
    const h = held.get(key) ?? 0;
    if (blocked !== h) {
      findings.push({
        check: "holds differ from ledger block",
        fix: "emd:rebuild-balances, then investigate",
        detail: `auction ${l.auction_id} bidder ${l.bidder_id} ledger ${blocked} holds ${h}`,
      });
    }
  }

  for (const r of await rows<{ id: number; auction_id: number; bidder_id: number; lot_id: number }>(sql`
    SELECT DISTINCT h.id, h.auction_id, h.bidder_id, m.lot_id
    FROM emd_range_holds h
    JOIN auction_lot_bidder_maps m ON m.auction_id = h.auction_id AND m.bidder_id = h.bidder_id
      AND m.lot_id = ANY(h.lot_ids) AND m.is_emd_with_client = true`)) {
    findings.push({
      check: "hold lists a with-client lot",
      fix: "emd:recompute-with-client-holds",
      detail: `hold ${r.id} auction ${r.auction_id} bidder ${r.bidder_id} lot ${r.lot_id}`,
    });
  }

  const byCheck = new Map<string, Finding[]>();
  for (const f of findings) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
  for (const [check, list] of byCheck) {
    console.log(`\n${check}: ${list.length}  ->  ${list[0]!.fix}`);
    for (const f of list.slice(0, 10)) console.log(`  ${f.detail}`);
    if (list.length > 10) console.log(`  ... ${list.length - 10} more`);
  }
  console.log(findings.length === 0 ? "emd holds OK" : `\n${findings.length} finding(s)`);
  if (findings.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

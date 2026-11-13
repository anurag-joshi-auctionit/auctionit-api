import { sql } from "drizzle-orm";
import { db, pool } from "./index.js";
import { refreshBalanceCachesSql } from "../lib/emd/blocked.js";

/**
 * One-off, safe to re-run. Before the single Blocked balance, a won range was
 * moved to a separate Winning balance by `blocked_winning` ledger rows. Now it
 * stays blocked and `emd_range_holds` records what it covers. This builds a
 * hold row for every (auction, bidder, range) that has `blocked_winning` rows:
 *
 *   amount_held      = what was blocked as Winning for the range
 *   amount_released  = Winning credited back for it (lifting release, lot
 *                      rejection)
 *   amount_forfeited = approved forfeitures on the range
 *   lot_ids          = the won lots recorded on those rows
 *
 * Existing rows are left alone. The ledger is not changed: a `blocked_winning`
 * debit and its close credit still cancel, so each bidder's Blocked balance is
 * the old Blocked plus the old Winning. Run before deploying the code that reads
 * holds, then `pnpm emd:rebuild-balances`.
 *
 * Run when / applies to / retire when: docs/ops/emd-one-off-scripts.md
 */
async function main() {
  const started = Date.now();
  const res = await db.execute(sql`
    INSERT INTO emd_range_holds
      (auction_id, bidder_id, emd_range_id, amount_held, amount_released, amount_forfeited, lot_ids)
    SELECT w.auction_id, w.bidder_id, w.emd_range_id, w.held,
           COALESCE(r.released, 0), COALESCE(f.forfeited, 0), COALESCE(w.lot_ids, '{}')
    FROM (
      SELECT t.auction_id, t.bidder_id, t.emd_range_id, SUM(t.amount) AS held,
             (SELECT COALESCE(array_agg(DISTINCT l.lot_id), '{}')
                FROM emd_transactions x, unnest(x.winning_lot_ids) AS l(lot_id)
               WHERE x.auction_id = t.auction_id AND x.bidder_id = t.bidder_id
                 AND x.emd_type = 'blocked_winning'
                 AND x.emd_range_id IS NOT DISTINCT FROM t.emd_range_id) AS lot_ids
      FROM emd_transactions t
      WHERE t.emd_type = 'blocked_winning' AND t.auction_id IS NOT NULL
      GROUP BY t.auction_id, t.bidder_id, t.emd_range_id
    ) w
    LEFT JOIN (
      SELECT t.auction_id, t.bidder_id, t.emd_range_id, SUM(t.amount) AS released
      FROM emd_transactions t
      WHERE t.emd_type IN ('release_lot_rejected', 'release_winning_by_admin')
        AND t.auction_id IS NOT NULL
      GROUP BY t.auction_id, t.bidder_id, t.emd_range_id
    ) r ON r.auction_id = w.auction_id AND r.bidder_id = w.bidder_id
       AND r.emd_range_id IS NOT DISTINCT FROM w.emd_range_id
    LEFT JOIN (
      SELECT f.auction_id, f.bidder_id, f.emd_range_id, SUM(f.amount) AS forfeited
      FROM emd_forfeitures f
      WHERE f.status = 'forfeited'
      GROUP BY f.auction_id, f.bidder_id, f.emd_range_id
    ) f ON f.auction_id = w.auction_id AND f.bidder_id = w.bidder_id
       AND f.emd_range_id IS NOT DISTINCT FROM w.emd_range_id
    WHERE NOT EXISTS (
      SELECT 1 FROM emd_range_holds h
      WHERE h.auction_id = w.auction_id AND h.bidder_id = w.bidder_id
        AND h.emd_range_id IS NOT DISTINCT FROM w.emd_range_id
    )
  `);
  console.log(`emd range holds created: ${res.rowCount ?? 0} in ${Date.now() - started}ms`);
  const refreshed = await db.execute(refreshBalanceCachesSql(null));
  console.log(`emd balances rebuilt for ${refreshed.rowCount ?? 0} bidders`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

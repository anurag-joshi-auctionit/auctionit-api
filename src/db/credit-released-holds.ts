import { sql } from "drizzle-orm";
import { db, pool } from "./index.js";
import { refreshBalanceCachesSql } from "../lib/emd/blocked.js";
import { round2 } from "../lib/emd/constants.js";
import { emdTransactionsService } from "../services/emd-transactions.service.js";

/**
 * One-off, safe to re-run. A lot released while other lots of its holding were
 * still pending is only recorded in `emd_winning_lot_releases`; the credit
 * posts when the holding's last pending lot clears. If the holding is later
 * split per range, a range whose lots are all released has nothing left to
 * trigger that credit. This posts `release_winning_by_admin` for every hold
 * that still has money held although every lot it covers is released and no
 * forfeiture is open, updates `amount_released`, and links the release rows.
 *
 * Dry run by default. `--apply --hold <id>` credits that hold only, so each
 * repair is reviewed on its own.
 *
 * Run when / applies to / retire when: docs/ops/emd-one-off-scripts.md
 */
const apply = process.argv.includes("--apply");
const holdArg = process.argv.indexOf("--hold");
const onlyHold = holdArg >= 0 ? Number(process.argv[holdArg + 1]) : null;

type Row = {
  id: number;
  auction_id: number;
  bidder_id: number;
  emd_range_id: number | null;
  remaining: string;
  lot_ids: number[];
  remarks: string | null;
  released_by: number;
};

async function main() {
  if (apply && !onlyHold) throw new Error("--apply needs --hold <id>");
  const rows = (
    await db.execute(sql`
      SELECT h.id, h.auction_id, h.bidder_id, h.emd_range_id, h.lot_ids,
             (h.amount_held - h.amount_released - h.amount_forfeited) AS remaining,
             (SELECT string_agg(DISTINCT r.remarks, '; ') FROM emd_winning_lot_releases r
               WHERE r.bidder_id = h.bidder_id AND r.lot_id = ANY(h.lot_ids)) AS remarks,
             (SELECT max(r.created_by) FROM emd_winning_lot_releases r
               WHERE r.bidder_id = h.bidder_id AND r.lot_id = ANY(h.lot_ids)) AS released_by
      FROM emd_range_holds h
      WHERE h.amount_held - h.amount_released - h.amount_forfeited > 0
        AND cardinality(h.lot_ids) > 0
        AND NOT EXISTS (
          SELECT 1 FROM unnest(h.lot_ids) l(id)
          WHERE NOT EXISTS (SELECT 1 FROM emd_winning_lot_releases r
                            WHERE r.bidder_id = h.bidder_id AND r.lot_id = l.id))
        AND NOT EXISTS (
          SELECT 1 FROM emd_forfeitures f
          WHERE f.auction_id = h.auction_id AND f.bidder_id = h.bidder_id
            AND f.emd_range_id IS NOT DISTINCT FROM h.emd_range_id AND f.status <> 'rejected')
      ORDER BY h.id`)
  ).rows as unknown as Row[];

  for (const r of rows) {
    console.log(
      `hold ${r.id} (auction ${r.auction_id}, bidder ${r.bidder_id}, range ${r.emd_range_id}): ` +
        `credit ${r.remaining} for lots [${r.lot_ids}] remarks "${r.remarks}"`,
    );
  }
  if (!apply) return console.log(`would credit ${rows.length} hold(s); pass --apply --hold <id>`);

  const r = rows.find((x) => x.id === onlyHold);
  if (!r) throw new Error(`hold ${onlyHold} is not eligible`);
  await emdTransactionsService.run(async (tx) => {
    await emdTransactionsService.lockBidders(tx, [r.bidder_id]);
    const amount = round2(Number(r.remaining));
    const [txnId] = await emdTransactionsService.postMany(tx, [
      {
        bidderId: r.bidder_id,
        emdType: "release_winning_by_admin" as const,
        amount,
        auctionId: r.auction_id,
        emdRangeId: r.emd_range_id,
        winningLotIds: r.lot_ids,
        remarks: (r.remarks ?? "release").slice(0, 500),
        createdBy: r.released_by,
      },
    ]);
    await tx.execute(sql`
      UPDATE emd_range_holds SET amount_released = amount_released + ${amount}, updated_at = now()
      WHERE id = ${r.id}`);
    await tx.execute(sql`
      UPDATE emd_winning_lot_releases
      SET transaction_id = ${txnId}, emd_range_id = COALESCE(emd_range_id, ${r.emd_range_id}::int)
      WHERE bidder_id = ${r.bidder_id} AND lot_id = ANY(${sql`ARRAY[${sql.join(r.lot_ids.map((i) => sql`${i}`), sql`, `)}]::int[]`})`);
    console.log(`credited ${amount} (ledger ${txnId})`);
  });
  const refreshed = await db.execute(refreshBalanceCachesSql(null));
  console.log(`emd balances rebuilt for ${refreshed.rowCount ?? 0} bidders`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

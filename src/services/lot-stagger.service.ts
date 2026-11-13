import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  planCascadeFromAnchor,
  shouldStagger,
  type CascadeLotInput,
  type CascadePlanItem,
} from "../lib/auctions/stagger.js";

const EFFECTIVE_END = sql`COALESCE(
  l.extended_end_time,
  (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'
)`;

export type StaggeredLot = {
  lotId: number;
  auctionId: number;
  oldEndsAt: string;
  newEndsAt: string;
  extendedBySec: number;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type SiblingRow = {
  id: number;
  display_order: string | null;
  effective_end_ms: string;
};

/**
 * Apply sequential stagger cascade from an anchor lot onto later open lots
 * (`end[n] = end[n-1] + interval`). Callers must pass the **post-extension**
 * end so the chain starts from the new end. Called only as a side effect of
 * an actual extension — the no-bid path and the last-bid path — never from a
 * lot merely approaching its own scheduled close.
 */
export async function applyCascadeFromAnchor(
  tx: Tx,
  opts: {
    auctionId: number;
    anchorLotId: number;
    /** Anchor's current (post-extension) effective end, epoch ms. */
    anchorEndMs: number;
    enabled: boolean;
    intervalSec: number;
  },
): Promise<StaggeredLot[]> {
  if (!shouldStagger(opts.enabled, opts.intervalSec)) return [];

  const siblings = await tx.execute<SiblingRow>(sql`
    SELECT
      l.id,
      l.display_order,
      (EXTRACT(EPOCH FROM (${EFFECTIVE_END})) * 1000)::bigint::text AS effective_end_ms
    FROM auction_lots l
    JOIN auctions a ON a.auction_id = l.auction_id
    WHERE l.auction_id = ${opts.auctionId}
      AND l.is_active = true
      AND l.end_time IS NOT NULL
      -- Reopened lots run on their own end time: never moved by, nor anchoring, the chain.
      AND NOT l.is_reopened
  `);

  const lots: CascadeLotInput[] = siblings.rows.map((r) => ({
    id: r.id,
    displayOrder: r.display_order == null ? null : Number(r.display_order),
    effectiveEndMs: Number(r.effective_end_ms),
  }));

  const plan = planCascadeFromAnchor({
    enabled: opts.enabled,
    intervalSec: opts.intervalSec,
    anchorLotId: opts.anchorLotId,
    anchorEndMs: opts.anchorEndMs,
    lots,
  });
  if (plan.length === 0) return [];

  return applyCascadePlan(tx, opts.auctionId, plan);
}

async function applyCascadePlan(
  tx: Tx,
  auctionId: number,
  plan: CascadePlanItem[],
): Promise<StaggeredLot[]> {
  const out: StaggeredLot[] = [];
  for (const item of plan) {
    const newIso = new Date(item.newEndsAtMs).toISOString();
    const oldIso = new Date(item.oldEndsAtMs).toISOString();
    const updated = await tx.execute<{
      old_end: string;
      new_end: string;
    }>(sql`
      UPDATE auction_lots
      SET extended_end_time = ${newIso}::timestamptz,
          live_rev = live_rev + 1,
          updated_at = now()
      WHERE id = ${item.lotId}
      RETURNING
        to_char(${oldIso}::timestamptz AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD"T"HH24:MI:SS') AS old_end,
        to_char(extended_end_time AT TIME ZONE 'Asia/Kolkata',
                'YYYY-MM-DD"T"HH24:MI:SS') AS new_end
    `);
    const row = updated.rows[0];
    if (!row) continue;
    out.push({
      lotId: item.lotId,
      auctionId,
      oldEndsAt: row.old_end,
      newEndsAt: row.new_end,
      extendedBySec: item.extendedBySec,
    });
  }

  if (out.length > 0) {
    const values = sql.join(
      out.map(
        (r) =>
          sql`(${r.auctionId}, ${r.lotId}, ${r.oldEndsAt}::timestamp, ${r.newEndsAt}::timestamp, ${r.extendedBySec}, NULL, 'stagger'::lot_extension_reason)`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      INSERT INTO auction_lot_extensions
        (auction_id, lot_id, old_ends_at, new_ends_at, extended_by_sec, triggered_by_bidder_id, reason)
      VALUES ${values}
    `);
  }
  return out;
}

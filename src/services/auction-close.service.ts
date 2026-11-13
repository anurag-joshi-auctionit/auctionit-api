import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emdSettlementService } from "./emd-settlement.service.js";

/**
 * Advisory lock serializing the lot-resolution tick (no-bid extend, then
 * close — see no-bid-extension.service.ts) across API instances. Also taken
 * by pgReopenLots so a reopen can never land while a close is committing.
 */
export const CLOSE_LOCK_KEY = 4213_0002;

/**
 * The close predicate itself: flip published → closed for auctions whose
 * bidding has ended (every active lot's effective end — COALESCE(extended_
 * end_time, auction_date + end_time) in IST — is in the past), stamping
 * closed_at. Idempotent (status = 'published' guard). Takes the caller's
 * transaction so it can run immediately after a no-bid extension UPDATE in
 * the SAME transaction — the whole point being that this query's own
 * COALESCE re-read sees any extended_end_time just written moments earlier,
 * so a lot that was just extended can never be read as closed in the same
 * breath. Call under CLOSE_LOCK_KEY (see no-bid-extension.service.ts).
 */
export async function closeEndedLots(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<number[]> {
  const res = await tx.execute<{ auction_id: number }>(sql`
    UPDATE auctions a
    SET status = 'closed', closed_at = now(), updated_at = now()
    WHERE a.status = 'published'
      AND a.is_active
      AND EXISTS (
        SELECT 1 FROM auction_lots l
        WHERE l.auction_id = a.auction_id AND l.is_active
      )
      AND NOT EXISTS (
        SELECT 1 FROM auction_lots l
        WHERE l.auction_id = a.auction_id AND l.is_active
          AND COALESCE(
                l.extended_end_time,
                (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'
              ) > now()
      )
    RETURNING a.auction_id
  `);
  const closedIds = res.rows.map((r) => r.auction_id);
  await emdSettlementService.enqueueClosed(tx, closedIds);
  return closedIds;
}

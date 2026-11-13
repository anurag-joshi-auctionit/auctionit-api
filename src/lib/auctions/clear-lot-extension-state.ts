import { and, eq, inArray } from "drizzle-orm";
import { formatUtcNow } from "@auctionit/lib/date";
import { auctionLots } from "../../db/schema/auction-lots.js";
import type { db } from "../../db/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Clear a lot's accrued extension state — extended_end_time, the no-bid/
 * last-bid counters, and no-bid stop metadata — so a stale extension from
 * before a schedule change can't silently outlive it. effective_end is
 * COALESCE(extended_end_time, scheduled end) everywhere (no-bid tick,
 * auto-close, live snapshot), so a leftover extended_end_time would
 * otherwise keep winning over a freshly-set start/end time.
 *
 * Pass "all-active" for every active lot in the auction (republishing a
 * rescheduled auction), or a specific lotIds list to touch only the lots
 * whose time actually changed (bulk import onto a live auction).
 */
export async function clearLotExtensionState(
  client: typeof db | Tx,
  auctionId: number,
  lotIds: number[] | "all-active",
  userId: number,
): Promise<void> {
  const scope =
    lotIds === "all-active"
      ? eq(auctionLots.isActive, true)
      : and(inArray(auctionLots.id, lotIds), eq(auctionLots.isActive, true));
  await client
    .update(auctionLots)
    .set({
      extendedEndTime: null,
      lastBidExtensionCount: 0,
      noBidExtensionCount: 0,
      noBidExtensionStoppedAt: null,
      noBidExtensionStoppedBy: null,
      updatedAt: formatUtcNow(),
      updatedBy: userId,
    })
    .where(and(eq(auctionLots.auctionId, auctionId), scope));
}

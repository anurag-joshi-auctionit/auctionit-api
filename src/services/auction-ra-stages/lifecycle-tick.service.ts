import { formatUtcNow } from "@auctionit/lib/date";
import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import { auctions } from "../../db/schema/auctions.js";

export type AuctionRaStageLifecycleSyncFilter = {
  auctionId?: number;
};

export type AuctionRaStageLifecycleSyncResult = {
  resetToDraft: number;
  closedByAuction: number;
  published: number;
  closed: number;
};

function auctionsScope(
  statusCondition: ReturnType<typeof eq> | ReturnType<typeof ne>,
  filter?: AuctionRaStageLifecycleSyncFilter,
) {
  return db
    .select({ id: auctions.id })
    .from(auctions)
    .where(
      filter?.auctionId
        ? and(statusCondition, eq(auctions.id, filter.auctionId))
        : statusCondition,
    );
}

/**
 * The only thing that ever changes a stage's status. No manual open/close/
 * reopen action exists anywhere — a stage's status is entirely derived from
 * its own `startsAt`/`endsAt` AND its parent auction's status:
 *   - auction not published (draft/archived) -> every enabled stage is reset
 *     to draft, regardless of its own dates.
 *   - auction published -> normal draft -> published -> closed progression
 *     from the stage's own startsAt/endsAt.
 *   - auction closed -> every enabled stage is force-closed immediately,
 *     regardless of its own endsAt.
 * Called both periodically (global sweep, see index.ts) and synchronously,
 * scoped to one auction, whenever that auction's own status changes (see
 * auctions.service.ts publish/unpublish/archive and auction-close.service.ts)
 * so badges never lag behind the auction they belong to.
 */
export async function runRaStageLifecycleSync(
  filter?: AuctionRaStageLifecycleSyncFilter,
): Promise<AuctionRaStageLifecycleSyncResult> {
  const now = formatUtcNow();

  const resetToDraft = await db
    .update(auctionRaStages)
    .set({ status: "draft", publishedAt: null, closedAt: null })
    .where(
      and(
        eq(auctionRaStages.enabled, true),
        ne(auctionRaStages.status, "draft"),
        inArray(
          auctionRaStages.auctionId,
          auctionsScope(ne(auctions.status, "published"), filter),
        ),
      ),
    )
    .returning({ id: auctionRaStages.id });

  const closedByAuction = await db
    .update(auctionRaStages)
    .set({
      status: "closed",
      closedAt: sql`coalesce(${auctionRaStages.closedAt}, ${now})`,
    })
    .where(
      and(
        eq(auctionRaStages.enabled, true),
        ne(auctionRaStages.status, "closed"),
        inArray(
          auctionRaStages.auctionId,
          auctionsScope(eq(auctions.status, "closed"), filter),
        ),
      ),
    )
    .returning({ id: auctionRaStages.id });

  const publishedAuctionIds = auctionsScope(eq(auctions.status, "published"), filter);

  const published = await db
    .update(auctionRaStages)
    .set({ status: "published", publishedAt: now })
    .where(
      and(
        eq(auctionRaStages.enabled, true),
        eq(auctionRaStages.status, "draft"),
        lte(auctionRaStages.startsAt, now),
        inArray(auctionRaStages.auctionId, publishedAuctionIds),
      ),
    )
    .returning({ id: auctionRaStages.id });

  const closed = await db
    .update(auctionRaStages)
    .set({ status: "closed", closedAt: now })
    .where(
      and(
        eq(auctionRaStages.enabled, true),
        eq(auctionRaStages.status, "published"),
        lte(auctionRaStages.endsAt, now),
        inArray(auctionRaStages.auctionId, publishedAuctionIds),
      ),
    )
    .returning({ id: auctionRaStages.id });

  return {
    resetToDraft: resetToDraft.length,
    closedByAuction: closedByAuction.length,
    published: published.length,
    closed: closed.length,
  };
}

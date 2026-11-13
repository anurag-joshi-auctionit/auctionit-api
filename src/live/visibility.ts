import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export type AuctionVisibility = {
  /** null = all lots (auction-wide map or admin). */
  lotIds: Set<number> | null;
};

const cache = new Map<string, { at: number; value: AuctionVisibility | null }>();
const TTL_MS = 30_000;

function cacheKey(bidderId: number, auctionId: number): string {
  return `${bidderId}:${auctionId}`;
}

/** Drop cached visibility for a bidder (call when maps change). */
export function invalidateBidderVisibility(bidderId: number): void {
  const prefix = `${bidderId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Resolve whether a bidder may watch an auction and which lots they may see.
 * Admins pass bidderId=null → full access. Returns null when the bidder is not
 * registered for the auction.
 */
export async function resolveAuctionVisibility(
  auctionId: number,
  bidderId: number | null,
): Promise<AuctionVisibility | null> {
  if (bidderId == null) {
    return { lotIds: null };
  }

  const key = cacheKey(bidderId, auctionId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const res = await db.execute<{ lot_id: number | null }>(sql`
    SELECT lot_id FROM auction_lot_bidder_maps
    WHERE auction_id = ${auctionId}
      AND bidder_id = ${bidderId}
      AND is_active = true
  `);

  let value: AuctionVisibility | null = null;
  if (res.rows.length > 0) {
    const hasAuctionWide = res.rows.some((r) => r.lot_id == null);
    value = hasAuctionWide
      ? { lotIds: null }
      : {
          lotIds: new Set(
            res.rows
              .map((r) => r.lot_id)
              .filter((id): id is number => id != null && id > 0),
          ),
        };
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}

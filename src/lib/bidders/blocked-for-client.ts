import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bidderBlockLogs } from "../../db/schema/bidder-blocks.js";

/**
 * All bidder IDs currently blocked for `clientId`.
 * Current state = latest `bidder_block_logs` row per (client, bidder).
 */
export async function currentlyBlockedBidderIdsForClient(
  clientId: number,
): Promise<number[]> {
  const ranked = db
    .select({
      bidderId: bidderBlockLogs.bidderId,
      isBlocked: bidderBlockLogs.isBlocked,
      rn: sql<number>`row_number() over (
        partition by ${bidderBlockLogs.bidderId}
        order by ${bidderBlockLogs.createdAt} desc, ${bidderBlockLogs.id} desc
      )`.as("rn"),
    })
    .from(bidderBlockLogs)
    .where(eq(bidderBlockLogs.clientId, clientId))
    .as("ranked");

  const rows = await db
    .select({ bidderId: ranked.bidderId })
    .from(ranked)
    .where(and(eq(ranked.rn, 1), eq(ranked.isBlocked, true)));

  return rows.map((r) => r.bidderId);
}

/**
 * Bidder IDs currently blocked for `clientId` among `bidderIds`.
 * Current state = latest `bidder_block_logs` row per (client, bidder).
 */
export async function blockedBidderIdsForClient(
  clientId: number,
  bidderIds: number[],
): Promise<Set<number>> {
  const uniqueIds = [...new Set(bidderIds.filter((id) => Number.isFinite(id)))];
  if (uniqueIds.length === 0) return new Set();

  const ranked = db
    .select({
      bidderId: bidderBlockLogs.bidderId,
      isBlocked: bidderBlockLogs.isBlocked,
      rn: sql<number>`row_number() over (
        partition by ${bidderBlockLogs.bidderId}
        order by ${bidderBlockLogs.createdAt} desc, ${bidderBlockLogs.id} desc
      )`.as("rn"),
    })
    .from(bidderBlockLogs)
    .where(
      and(
        eq(bidderBlockLogs.clientId, clientId),
        inArray(bidderBlockLogs.bidderId, uniqueIds),
      ),
    )
    .as("ranked");

  const rows = await db
    .select({ bidderId: ranked.bidderId })
    .from(ranked)
    .where(and(eq(ranked.rn, 1), eq(ranked.isBlocked, true)));

  return new Set(rows.map((r) => r.bidderId));
}

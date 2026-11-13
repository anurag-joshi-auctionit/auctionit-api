import { sql } from "drizzle-orm";
import { bidDirectionFor } from "@auctionit/lib/live-bid-bounds";
import { db } from "../db/index.js";
import { loadRankings } from "../lib/auctions/rank.js";
import {
  emitToAuctionAdmins,
  emitToAuctionClients,
  emitToAuctionPublic,
  getIo,
  type LiveSocket,
  type SocketUser,
} from "../live/socket.js";
import { auctionPublicRoom } from "../live/rooms.js";
import { ssePublishStanding } from "../live/sse-hub.js";
import {
  liveAuctionService,
  projectDeltaForAudience,
  type LiveAuctionSnapshot,
  type LiveLotDelta,
} from "../services/live-auction.service.js";
import { resolveAuctionVisibility } from "../live/visibility.js";
import {
  isPortalClientRole,
  userCanAccessAuction,
} from "../services/client-scope.js";
import { timedLive } from "../lib/live-timing.js";
import { participantStanding } from "./participant-standing.js";

export { participantStanding };

/**
 * Bidders whose `yourStatus` could have changed, supplied by the caller that
 * performed the write. Standing is a function of (winner, you, do you still
 * hold a live bid) — so a bidder who was neither the old nor the new winner,
 * and whose own rows did not move, still reads exactly as before and does not
 * need a ping. `currentBid` reaches everyone else on the room-wide `live:lot`.
 */
export type AffectedBidders = number[];

/**
 * Push audience-specific snapshots/deltas after a bid.
 * Admins and clients get winner identity; the public room does not.
 * Affected bidders (new winner / prior participants) also get a private standing ping.
 */
export function broadcastLotDelta(
  auctionId: number,
  lotId: number,
  affected?: AffectedBidders,
): void {
  void timedLive(`broadcastLotDelta:${lotId}`, async () => {
    const delta = await liveAuctionService.lotDelta(auctionId, lotId);
    if (!delta) return;
    emitToAuctionAdmins(auctionId, "live:lot", delta);
    // Shared public delta has no bidderId → yourStatus omitted, winner stripped.
    emitToAuctionPublic(
      auctionId,
      "live:lot",
      projectDeltaForAudience(delta, "bidder"),
    );
    emitToAuctionClients(
      auctionId,
      "live:lot",
      projectDeltaForAudience(delta, "client"),
    );
    await emitPrivateStanding(auctionId, delta, affected);
  }).catch((e) => console.error("live lot delta broadcast failed", e));
}

/**
 * Resolves once every room has been pushed, so the resync loop can use it as a
 * real in-flight guard instead of starting a fresh wave every tick while the
 * previous one is still querying.
 */
export function broadcastSnapshot(auctionId: number): Promise<void> {
  return timedLive(`broadcastSnapshot:${auctionId}`, async () => {
    const snapshots = await liveAuctionService.getBroadcastSnapshots(auctionId);
    if (!snapshots) return;
    emitToAuctionAdmins(auctionId, "live:snapshot", snapshots.admin);
    // Public room: one shared bidder projection (no winner names, no yourStatus).
    // Per-socket standing comes from join snapshots + live:standing.
    emitToAuctionPublic(auctionId, "live:snapshot", snapshots.bidder);
    emitToAuctionClients(auctionId, "live:snapshot", snapshots.client);
  }).catch((e) => console.error("live snapshot broadcast failed", e));
}

/**
 * Notify anyone who has bid (ledger or accepted log), holds an active proxy, or
 * is the current winner. Bid-logs are included so a removed winner still gets a ping
 * after corrections wipe their ledger row.
 *
 * Standing rules:
 * - no winner → "none" (e.g. last/only bid removed — never "outbid")
 * - you are winner → "winning"
 * - you still have a live bid but are not winner → "outbid"
 * - your bids were removed and you are not winner → "none"
 */
async function emitPrivateStanding(
  auctionId: number,
  delta: LiveLotDelta,
  affected?: AffectedBidders,
): Promise<void> {
  const io = getIo();
  const rankBased = delta.isRankBased === true;

  // Any rank-based bid can move every other bidder's rank, so the fast path
  // (only the bidders the write touched) is not enough there.
  const notify =
    affected && !rankBased
      ? // Fast path. Everyone the writer touched still holds a live bid or an
        // armed proxy — placeBid/setProxyBid only ever add rows, and the one row
        // they retire (your own proxy, superseded by your manual bid) leaves you
        // with a ledger entry either way.
        new Map(affected.map((bidderId) => [bidderId, true] as const))
      : await loadLotParticipants(delta.lotId);

  if (delta.winnerBidderId != null && !notify.has(delta.winnerBidderId)) {
    notify.set(delta.winnerBidderId, true);
  }
  if (notify.size === 0) return;

  // Private standing pings go straight to bidders and never pass through
  // projectDeltaForAudience, so the winning amount is masked here directly —
  // same rule as the public live:lot delta and the snapshot (rank-based, or the
  // sealed-bid phase where an unbid lot's currentBid is the withheld start price).
  const currentBid =
    rankBased || delta.sealedPhase === true ? null : delta.currentBid;
  const rankings = rankBased ? await loadLotRankings(delta.lotId) : undefined;

  // SSE watchers resolve their own standing per stream (including on other API
  // instances), so the participant set is published once rather than per client.
  ssePublishStanding({
    auctionId,
    lotId: delta.lotId,
    winnerBidderId: delta.winnerBidderId,
    currentBid,
    seq: delta.seq,
    rev: delta.rev,
    participants: [...notify.entries()],
    rankings: rankings
      ? [...rankings].map(
          ([id, r]): [number, number, number] => [id, r.rank, r.best],
        )
      : undefined,
  });

  if (!io) return;
  const sockets = await io.in(auctionPublicRoom(auctionId)).fetchSockets();
  for (const raw of sockets) {
    const s = raw as unknown as LiveSocket;
    const bidderId = s.data?.user?.bidderId;
    if (bidderId == null || !notify.has(bidderId)) continue;
    const yourStatus = participantStanding({
      winnerBidderId: delta.winnerBidderId,
      bidderId,
      hasLiveBid: notify.get(bidderId) === true,
    });
    // Each socket gets only its own rank and bid, never anyone else's.
    const mine = rankings?.get(bidderId);
    s.emit("live:standing", {
      auctionId,
      lotId: delta.lotId,
      yourStatus,
      currentBid,
      seq: delta.seq,
      rev: delta.rev,
      ...(rankings
        ? { yourRank: mine?.rank ?? null, yourBid: mine?.best ?? null }
        : {}),
    });
  }
}

/** Every bidder's rank and best bid on a rank-based lot, keyed by bidder. */
async function loadLotRankings(
  lotId: number,
): Promise<Map<number, { rank: number; best: number }>> {
  const typeRes = await db.execute<{ auction_type: string | null }>(sql`
    SELECT a.auction_type FROM auction_lots l
    JOIN auctions a ON a.auction_id = l.auction_id
    WHERE l.id = ${lotId}
  `);
  const rows = await loadRankings(
    db,
    sql`lot_id = ${lotId}`,
    bidDirectionFor(typeRes.rows[0]?.auction_type ?? null),
  );
  return new Map(rows.map((r) => [r.bidderId, { rank: r.rank, best: r.best }]));
}

/**
 * Full participant set for a lot, rebuilt from history.
 *
 * Cost grows with the lot's bid count, so this is the correction fallback only:
 * an admin removing a winning bid can flip a bidder from "outbid" to "none"
 * without that bidder appearing in any write, and only a rescan finds them.
 * The bid path passes its own affected set instead.
 *
 * DISTINCT per branch keeps each leg on its covering index rather than reading
 * (and deduplicating) one row per historical bid.
 */
async function loadLotParticipants(
  lotId: number,
): Promise<Map<number, boolean>> {
  const participants = await db.execute<{
    bidder_id: number;
    has_live_bid: boolean;
  }>(sql`
    SELECT bidder_id,
           -- Live ledger or armed proxy = still participating. Log-only means
           -- their bid was corrected away and they should clear to "none".
           bool_or(has_live) AS has_live_bid
    FROM (
      SELECT DISTINCT bidder_id, true AS has_live
      FROM auction_bids WHERE lot_id = ${lotId}
      UNION ALL
      SELECT DISTINCT bidder_id, false AS has_live
      FROM auction_bid_logs
      WHERE lot_id = ${lotId} AND is_accepted = true
      UNION ALL
      SELECT DISTINCT bidder_id, true AS has_live
      FROM auction_proxy_bids
      WHERE lot_id = ${lotId} AND is_active = true
    ) t
    GROUP BY bidder_id
  `);
  return new Map(
    participants.rows.map((r) => [r.bidder_id, r.has_live_bid === true]),
  );
}

/**
 * Join snapshot tailored to a user's audience + visibility, or null when they
 * may not watch the auction. Shared by Socket.IO joins and SSE subscriptions so
 * both transports hand out byte-identical first payloads.
 */
export async function resolveJoinSnapshot(
  user: SocketUser,
  auctionId: number,
): Promise<LiveAuctionSnapshot | null> {
  if (isPortalClientRole(user.roleCode)) {
    if (!(await userCanAccessAuction(user.id, auctionId))) return null;
    return liveAuctionService.getSnapshot(auctionId, { audience: "client" });
  }
  const isStaffAdmin = user.isAdmin && user.bidderId == null;
  if (isStaffAdmin) {
    return liveAuctionService.getSnapshot(auctionId, { audience: "admin" });
  }

  const visibility = await resolveAuctionVisibility(auctionId, user.bidderId);
  if (!visibility) return null;
  return liveAuctionService.getSnapshot(auctionId, {
    audience: "bidder",
    bidderId: user.bidderId,
    visibility,
  });
}

/** Push a join snapshot tailored to this socket's audience + visibility. */
export async function pushJoinSnapshot(
  socket: LiveSocket,
  auctionId: number,
): Promise<void> {
  const snapshot = await resolveJoinSnapshot(socket.data.user, auctionId);
  if (snapshot) socket.emit("live:snapshot", snapshot);
}

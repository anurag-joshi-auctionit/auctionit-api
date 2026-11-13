import type { Request, Response } from "express";
import { AuthzErrorMessages } from "@auctionit/messages/authz";
import { LiveAuctionMessages } from "@auctionit/messages/live";
import { env } from "../env.js";
import {
  isPortalClientRole,
  userCanAccessAuction,
} from "../services/client-scope.js";
import { resolveJoinSnapshot } from "./broadcast.js";
import { resolveAuctionVisibility } from "./visibility.js";
import {
  auctionAdminRoom,
  auctionClientRoom,
  auctionPublicRoom,
} from "./rooms.js";
import {
  addSseClient,
  removeSseClient,
  sseAtCapacity,
  writeSseEvent,
  type SseUser,
} from "./sse-hub.js";
import type { SocketUser } from "./socket.js";

/** Matches the Socket.IO `live:watch` cap on how many rooms one client holds. */
const MAX_STREAM_AUCTIONS = 25;

function parseAuctionIds(raw: unknown): number[] {
  const text =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === "string").join(",")
        : "";
  const ids = new Set<number>();
  for (const part of text.split(",")) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].slice(0, MAX_STREAM_AUCTIONS);
}

/**
 * Room this user belongs in for `auctionId`, or null when they may not watch
 * it. Mirrors joinAuctionRoom so an SSE client never sees a projection its
 * socket equivalent would have been denied.
 */
async function resolveRoom(
  user: SocketUser,
  auctionId: number,
): Promise<string | null> {
  if (isPortalClientRole(user.roleCode)) {
    return (await userCanAccessAuction(user.id, auctionId))
      ? auctionClientRoom(auctionId)
      : null;
  }
  if (user.isAdmin && user.bidderId == null) return auctionAdminRoom(auctionId);
  // Bidders — including ones with elevated roles — stay in the public
  // projection and must be registered for the auction.
  const visibility = await resolveAuctionVisibility(auctionId, user.bidderId);
  return visibility ? auctionPublicRoom(auctionId) : null;
}

/**
 * SSE fallback for the live push channel. Server→client only: bids keep going
 * over the REST endpoints, so a client on this transport loses nothing but the
 * socket itself.
 *
 * EventSource can't set headers, so the app id arrives as `?app_id=` and
 * requireAuth resolves the matching `session_<appId>` cookie.
 */
export async function liveSseHandler(
  req: Request,
  res: Response,
): Promise<void> {
  if (!env.LIVE_SSE_ENABLED) {
    res.status(503).json({ error: LiveAuctionMessages.SSE_DISABLED });
    return;
  }
  if (sseAtCapacity()) {
    res.status(503).json({ error: LiveAuctionMessages.SSE_CAPACITY_REACHED });
    return;
  }
  const authed = req.user;
  if (!authed) {
    res.status(401).json({ error: AuthzErrorMessages.UNAUTHENTICATED, code: "session_invalid" });
    return;
  }

  const auctionIds = parseAuctionIds(req.query.auctionIds);
  if (auctionIds.length === 0) {
    res.status(400).json({ error: LiveAuctionMessages.AUCTION_IDS_REQUIRED });
    return;
  }

  const user: SseUser = {
    id: authed.id,
    bidderId: authed.bidderId ?? null,
    isAdmin: authed.role.isAdmin,
    roleCode: authed.role.code,
  };

  const rooms: string[] = [];
  const denied: number[] = [];
  for (const auctionId of auctionIds) {
    const room = await resolveRoom(user, auctionId);
    if (room) rooms.push(room);
    else denied.push(auctionId);
  }
  if (rooms.length === 0) {
    res.status(403).json({ error: LiveAuctionMessages.AUCTIONS_FORBIDDEN });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx buffers proxied responses by default, which holds events back until
    // the buffer fills — fatal for a countdown feed.
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  // Never let the server-side idle timeout kill a stream that is working.
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  res.write(`retry: ${env.LIVE_SSE_RETRY_MS}\n\n`);

  const client = addSseClient({ res, user, rooms });
  writeSseEvent(client, "live:meta", {
    transport: "sse",
    serverTime: new Date().toISOString(),
    auctionIds: auctionIds.filter((id) => !denied.includes(id)),
  });
  for (const auctionId of denied) {
    writeSseEvent(client, "live:error", { error: "not_authorized", auctionId });
  }

  req.on("close", () => removeSseClient(client.id));

  for (const auctionId of auctionIds) {
    if (denied.includes(auctionId)) continue;
    try {
      const snapshot = await resolveJoinSnapshot(user, auctionId);
      if (snapshot) writeSseEvent(client, "live:snapshot", snapshot);
    } catch (err) {
      console.error(`sse join snapshot failed for auction ${auctionId}`, err);
    }
  }
}

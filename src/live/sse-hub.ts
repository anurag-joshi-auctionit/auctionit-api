import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { env } from "../env.js";
import { participantStanding } from "./participant-standing.js";
import { auctionPublicRoom, parseAuctionIdFromRoom } from "./rooms.js";
import { publishLive, subscribeLive } from "./redis.js";

/** Identity carried by an SSE stream — mirrors SocketUser on the socket side. */
export type SseUser = {
  id: number;
  bidderId: number | null;
  isAdmin: boolean;
  roleCode: string;
};

type SseClient = {
  id: string;
  res: Response;
  user: SseUser;
  rooms: Set<string>;
  heartbeat: NodeJS.Timeout;
};

// Fanout channel shared by every API instance. Each message names the room it
// targets, so a bid handled on one node still reaches SSE watchers on another.
const FANOUT_CHANNEL = "live:sse";
// Stamped on every published message so the originating node doesn't deliver
// the same payload twice (once locally, once off its own subscription).
const NODE_ID = randomUUID();

type RoomMessage = {
  kind: "room";
  from: string;
  room: string;
  event: string;
  payload: unknown;
};

/**
 * Standing is per-bidder, so it can't be addressed by room. We ship the
 * participant set and let every node resolve standing for the bidders it is
 * actually streaming to.
 */
type StandingMessage = {
  kind: "standing";
  from: string;
  auctionId: number;
  lotId: number;
  winnerBidderId: number | null;
  currentBid: number | null;
  seq?: number;
  rev?: number;
  /** [bidderId, hasLiveBid] — a live ledger row or an armed proxy. */
  participants: [number, boolean][];
  /** Rank-based lots: [bidderId, rank, ownBest]. Each stream gets only its own row. */
  rankings?: [number, number, number][];
};

type FanoutMessage = RoomMessage | StandingMessage;

const clients = new Map<string, SseClient>();
// room -> subscribers. Broadcasts run on the bid path, so they resolve their
// audience by lookup rather than scanning every open stream.
const byRoom = new Map<string, Set<SseClient>>();

export function sseClientCount(): number {
  return clients.size;
}

export function sseAtCapacity(): boolean {
  return clients.size >= env.LIVE_SSE_MAX_CLIENTS;
}

/** Auction ids with at least one SSE watcher on this instance. */
export function getSseAuctionIds(): number[] {
  const ids = new Set<number>();
  for (const room of byRoom.keys()) {
    const id = parseAuctionIdFromRoom(room);
    if (id != null) ids.add(id);
  }
  return [...ids];
}

function write(client: SseClient, chunk: string): void {
  // A peer can vanish between the room lookup and the write. Dropping the
  // client here (rather than throwing) keeps a dead stream from failing the
  // bid path that triggered the broadcast.
  if (client.res.writableEnded || client.res.destroyed) {
    removeSseClient(client.id);
    return;
  }
  try {
    client.res.write(chunk);
  } catch (err) {
    console.error("sse write failed; dropping client", err);
    removeSseClient(client.id);
  }
}

export function writeSseEvent(
  client: SseClient,
  event: string,
  payload: unknown,
): void {
  write(client, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function addSseClient(opts: {
  res: Response;
  user: SseUser;
  rooms: Iterable<string>;
}): SseClient {
  const client: SseClient = {
    id: randomUUID(),
    res: opts.res,
    user: opts.user,
    rooms: new Set(opts.rooms),
    // Keeps proxies from reaping an idle stream, and gives the client something
    // to measure silence against between auction events. It has to be a named
    // event rather than an SSE comment: EventSource swallows comments, so a
    // client can't tell a quiet-but-healthy stream from a dead one.
    heartbeat: setInterval(() => {
      writeSseEvent(client, "live:ping", { serverTime: Date.now() });
    }, env.LIVE_SSE_HEARTBEAT_MS),
  };
  clients.set(client.id, client);
  for (const room of client.rooms) {
    const set = byRoom.get(room);
    if (set) set.add(client);
    else byRoom.set(room, new Set([client]));
  }
  opts.res.on("error", () => removeSseClient(client.id));
  return client;
}

export function removeSseClient(id: string): void {
  const client = clients.get(id);
  if (!client) return;
  clearInterval(client.heartbeat);
  clients.delete(id);
  for (const room of client.rooms) {
    const set = byRoom.get(room);
    if (!set) continue;
    set.delete(client);
    if (set.size === 0) byRoom.delete(room);
  }
  try {
    client.res.end();
  } catch {
    // Response already torn down by the peer — nothing left to close.
  }
}

function deliverToRoom(room: string, event: string, payload: unknown): void {
  const subscribers = byRoom.get(room);
  if (!subscribers) return;
  // Copy: a failed write drops the client, mutating the set mid-iteration.
  for (const client of [...subscribers]) {
    writeSseEvent(client, event, payload);
  }
}

/**
 * Mirror of a Socket.IO room emit for SSE subscribers: delivered locally and
 * published for the other instances.
 */
export function ssePublishToRoom(
  room: string,
  event: string,
  payload: unknown,
): void {
  // With the channel turned off no instance can have subscribers, so skip the
  // Redis round trip entirely rather than paying it on every bid broadcast.
  if (!env.LIVE_SSE_ENABLED) return;
  deliverToRoom(room, event, payload);
  const message: RoomMessage = {
    kind: "room",
    from: NODE_ID,
    room,
    event,
    payload,
  };
  publishLive(FANOUT_CHANNEL, JSON.stringify(message));
}

function deliverStanding(message: StandingMessage): void {
  const publicRoom = auctionPublicRoom(message.auctionId);
  const subscribers = byRoom.get(publicRoom);
  if (!subscribers) return;
  const notify = new Map(message.participants);
  const rankings = message.rankings
    ? new Map(message.rankings.map(([id, rank, best]) => [id, { rank, best }]))
    : undefined;
  for (const client of [...subscribers]) {
    const bidderId = client.user.bidderId;
    if (bidderId == null || !notify.has(bidderId)) continue;
    const mine = rankings?.get(bidderId);
    writeSseEvent(client, "live:standing", {
      auctionId: message.auctionId,
      lotId: message.lotId,
      yourStatus: participantStanding({
        winnerBidderId: message.winnerBidderId,
        bidderId,
        hasLiveBid: notify.get(bidderId) === true,
      }),
      currentBid: message.currentBid,
      seq: message.seq,
      rev: message.rev,
      ...(rankings
        ? { yourRank: mine?.rank ?? null, yourBid: mine?.best ?? null }
        : {}),
    });
  }
}

export function ssePublishStanding(opts: {
  auctionId: number;
  lotId: number;
  winnerBidderId: number | null;
  currentBid: number | null;
  seq?: number;
  rev?: number;
  participants: [number, boolean][];
  rankings?: [number, number, number][];
}): void {
  if (!env.LIVE_SSE_ENABLED) return;
  const message: StandingMessage = { kind: "standing", from: NODE_ID, ...opts };
  deliverStanding(message);
  publishLive(FANOUT_CHANNEL, JSON.stringify(message));
}

export async function initSseFanout(): Promise<void> {
  await subscribeLive(FANOUT_CHANNEL, (raw) => {
    let message: FanoutMessage;
    try {
      message = JSON.parse(raw) as FanoutMessage;
    } catch {
      return;
    }
    // Already delivered inline on the publishing instance.
    if (message.from === NODE_ID) return;
    if (message.kind === "room") {
      deliverToRoom(message.room, message.event, message.payload);
    } else if (message.kind === "standing") {
      deliverStanding(message);
    }
  });
}

/** Close every stream (transport kill switch / shutdown). */
export function closeAllSseClients(reason: string): void {
  for (const client of [...clients.values()]) {
    writeSseEvent(client, "live:close", { reason });
    removeSseClient(client.id);
  }
}

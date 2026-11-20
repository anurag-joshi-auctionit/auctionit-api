import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { env } from "../env.js";
import { sessionCookieNameFor } from "../auth/session-cookie.js";
import { authService, type AuthUser } from "../services/auth.service.js";
import { resolveAuctionVisibility } from "./visibility.js";
import {
  isPortalClientRole,
  userCanAccessAuction,
} from "../services/client-scope.js";
import {
  auctionAdminRoom,
  auctionClientRoom,
  auctionPublicRoom,
  isAuctionRoom,
  parseAuctionIdFromRoom,
} from "./rooms.js";
import { getSseAuctionIds, ssePublishToRoom } from "./sse-hub.js";

export {
  auctionAdminRoom,
  auctionClientRoom,
  auctionPublicRoom,
} from "./rooms.js";

// Identity we attach to each authenticated socket.
export type SocketUser = {
  id: number;
  bidderId: number | null;
  isAdmin: boolean;
  roleCode: string;
};

export type LiveSocket = Socket & {
  data: {
    user: SocketUser;
    lastRefreshAt?: number;
  };
};

// Minimal cookie-header parser (the express cookie-parser doesn't run on the
// socket handshake). Returns the value for `name` or null.
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

let io: Server | null = null;

type LiveHandlers = {
  onJoin?: (socket: LiveSocket, auctionId: number) => void | Promise<void>;
};
let handlers: LiveHandlers = {};

export function setLiveHandlers(next: LiveHandlers): void {
  handlers = next;
}

export function getIo(): Server | null {
  return io;
}

/**
 * Every room emit goes to both push transports: Socket.IO for connected
 * sockets, the SSE hub for clients that failed over. Callers stay unaware of
 * which transport a given watcher is on.
 */
function emitToRoom(room: string, event: string, payload: unknown): void {
  io?.to(room).emit(event, payload);
  ssePublishToRoom(room, event, payload);
}

/** Broadcast to both public and admin rooms for an auction. */
export function emitToAuction(
  auctionId: number,
  event: string,
  payload: unknown,
): void {
  emitToRoom(auctionPublicRoom(auctionId), event, payload);
  emitToRoom(auctionAdminRoom(auctionId), event, payload);
}

/** Admin-only broadcast (full winner identity). */
export function emitToAuctionAdmins(
  auctionId: number,
  event: string,
  payload: unknown,
): void {
  emitToRoom(auctionAdminRoom(auctionId), event, payload);
}

/** Public room broadcast (identity stripped). */
export function emitToAuctionPublic(
  auctionId: number,
  event: string,
  payload: unknown,
): void {
  emitToRoom(auctionPublicRoom(auctionId), event, payload);
}

/** Client room broadcast (winner identity, no relative standing). */
export function emitToAuctionClients(
  auctionId: number,
  event: string,
  payload: unknown,
): void {
  emitToRoom(auctionClientRoom(auctionId), event, payload);
}

/** Emit to a single socket (private standing). */
export function emitToSocket(
  socketId: string,
  event: string,
  payload: unknown,
): void {
  io?.to(socketId).emit(event, payload);
}

/**
 * Auction ids that currently have at least one watcher connected, over either
 * transport. SSE watchers must count here or the resync loop would stop
 * refreshing time-derived state for an auction whose bidders all failed over.
 */
export function getActiveAuctionIds(): number[] {
  const ids = new Set<number>(getSseAuctionIds());
  if (io) {
    for (const room of io.of("/").adapter.rooms.keys()) {
      if (!isAuctionRoom(room)) continue;
      const id = parseAuctionIdFromRoom(room);
      if (id != null) ids.add(id);
    }
  }
  return [...ids];
}

function leaveAllAuctionRooms(s: LiveSocket): void {
  for (const room of s.rooms) {
    if (isAuctionRoom(room)) s.leave(room);
  }
}

async function joinAuctionRoom(
  s: LiveSocket,
  auctionId: number,
): Promise<boolean> {
  const user = s.data.user;
  if (isPortalClientRole(user.roleCode)) {
    const ok = await userCanAccessAuction(user.id, auctionId);
    if (!ok) return false;
    s.join(auctionClientRoom(auctionId));
    return true;
  }
  // Admins (no bidderId) may watch anything; bidders must be registered.
  if (!user.isAdmin || user.bidderId != null) {
    // Staff with isAdmin and no bidderId → admin room. Bidders even with
    // elevated roles stay in the public projection.
  }
  const isStaffAdmin = user.isAdmin && user.bidderId == null;
  if (!isStaffAdmin) {
    const vis = await resolveAuctionVisibility(auctionId, user.bidderId);
    if (!vis) return false;
  }
  const room = isStaffAdmin
    ? auctionAdminRoom(auctionId)
    : auctionPublicRoom(auctionId);
  s.join(room);
  return true;
}

function logTransport(socket: Socket, phase: string): void {
  const name = socket.conn.transport.name;
  console.log(
    JSON.stringify({
      scope: "live",
      event: "socket_transport",
      phase,
      transport: name,
      socketId: socket.id,
    }),
  );
}

export async function createSocketServer(
  httpServer: HttpServer,
): Promise<Server> {
  const transports =
    env.SOCKET_TRANSPORTS.length > 0
      ? env.SOCKET_TRANSPORTS
      : (["polling", "websocket"] as ("polling" | "websocket")[]);

  const isLocal =
    env.NODE_ENV === "development" || env.NODE_ENV === "local";

  io = new Server(httpServer, {
    cors: isLocal ? { origin: "*" } : undefined,
    transports,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  if (env.REDIS_URL) {
    try {
      const pubClient = createClient({ url: env.REDIS_URL });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log("socket.io redis adapter attached");
    } catch (err) {
      console.error("socket.io redis adapter failed; using in-memory", err);
    }
  }

  io.use(async (socket, next) => {
    try {
      const appId =
        typeof socket.handshake.auth?.appId === "string"
          ? socket.handshake.auth.appId
          : undefined;
      const token = readCookie(
        socket.handshake.headers.cookie,
        sessionCookieNameFor(appId),
      );
      if (!token) return next(new Error("unauthorized"));
      const user: AuthUser | null = await authService.findBySession(token);
      if (!user) return next(new Error("unauthorized"));
      (socket as LiveSocket).data.user = {
        id: user.id,
        bidderId: user.bidderId ?? null,
        isAdmin: user.role.isAdmin,
        roleCode: user.role.code,
      };
      next();
    } catch (e) {
      next(e instanceof Error ? e : new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const s = socket as LiveSocket;
    logTransport(s, "connect");
    s.emit("live:meta", {
      transport: s.conn.transport.name,
      serverTime: new Date().toISOString(),
    });

    s.conn.on("upgrade", () => {
      logTransport(s, "upgrade");
      s.emit("live:meta", {
        transport: s.conn.transport.name,
        serverTime: new Date().toISOString(),
      });
    });

    s.on("live:join", async (rawId: unknown) => {
      const auctionId = Number(rawId);
      if (!Number.isInteger(auctionId) || auctionId <= 0) return;
      leaveAllAuctionRooms(s);
      const ok = await joinAuctionRoom(s, auctionId);
      if (!ok) {
        s.emit("live:error", { error: "not_authorized", auctionId });
        return;
      }
      await handlers.onJoin?.(s, auctionId);
    });

    s.on("live:leave", (rawId: unknown) => {
      const auctionId = Number(rawId);
      if (Number.isInteger(auctionId) && auctionId > 0) {
        s.leave(auctionPublicRoom(auctionId));
        s.leave(auctionAdminRoom(auctionId));
        s.leave(`auction:${auctionId}`);
      }
    });

    s.on("live:watch", async (rawIds: unknown) => {
      const ids = Array.isArray(rawIds)
        ? Array.from(
            new Set(
              rawIds
                .map((v) => Number(v))
                .filter((n) => Number.isInteger(n) && n > 0),
            ),
          )
        : [];
      const want = new Set<string>();
      for (const id of ids) {
        const isStaffAdmin = s.data.user.isAdmin && s.data.user.bidderId == null;
        want.add(
          isStaffAdmin ? auctionAdminRoom(id) : auctionPublicRoom(id),
        );
      }
      for (const room of s.rooms) {
        if (isAuctionRoom(room) && !want.has(room)) s.leave(room);
      }
      for (const id of ids) {
        const isStaffAdmin = s.data.user.isAdmin && s.data.user.bidderId == null;
        const room = isStaffAdmin
          ? auctionAdminRoom(id)
          : auctionPublicRoom(id);
        if (!s.rooms.has(room)) {
          const ok = await joinAuctionRoom(s, id);
          if (ok) await handlers.onJoin?.(s, id);
          else s.emit("live:error", { error: "not_authorized", auctionId: id });
        }
      }
    });

    s.on("live:refresh", async () => {
      const now = Date.now();
      const last = s.data.lastRefreshAt ?? 0;
      if (now - last < env.LIVE_REFRESH_MIN_INTERVAL_MS) return;
      s.data.lastRefreshAt = now;

      const auctionIds = new Set<number>();
      for (const room of s.rooms) {
        const id = parseAuctionIdFromRoom(room);
        if (id != null) auctionIds.add(id);
      }
      for (const id of auctionIds) {
        await handlers.onJoin?.(s, id);
      }
    });
  });

  return io;
}

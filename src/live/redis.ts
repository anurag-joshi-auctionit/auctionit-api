import { createClient } from "redis";
import { env } from "../env.js";

type RedisConn = ReturnType<typeof createClient>;
type MessageHandler = (message: string) => void;

// One pub/sub pair shared by the SSE hub and the transport-mode config. The
// Socket.IO adapter keeps its own pair (it needs exclusive use of its subscriber),
// so keeping ours separate avoids fighting over the subscriber connection.
let pub: RedisConn | null = null;
let sub: RedisConn | null = null;
let connecting: Promise<boolean> | null = null;

const handlers = new Map<string, Set<MessageHandler>>();

export function liveRedisEnabled(): boolean {
  return Boolean(env.REDIS_URL);
}

/**
 * Connect the shared pair. Safe to call repeatedly; returns false when no
 * REDIS_URL is configured or the connection failed, in which case every live
 * channel silently degrades to single-process fanout.
 */
export async function initLiveRedis(): Promise<boolean> {
  if (!env.REDIS_URL) return false;
  if (pub && sub) return true;
  connecting ??= (async () => {
    try {
      const pubClient = createClient({ url: env.REDIS_URL });
      const subClient = pubClient.duplicate();
      pubClient.on("error", (err) =>
        console.error("live redis pub error", err),
      );
      subClient.on("error", (err) =>
        console.error("live redis sub error", err),
      );
      await Promise.all([pubClient.connect(), subClient.connect()]);
      pub = pubClient;
      sub = subClient;
      // Re-arm channels registered before the connection came up.
      for (const channel of handlers.keys()) {
        await subClient.subscribe(channel, (message) => {
          dispatch(channel, message);
        });
      }
      return true;
    } catch (err) {
      console.error("live redis unavailable; using in-process fanout", err);
      connecting = null;
      return false;
    }
  })();
  return connecting;
}

function dispatch(channel: string, message: string): void {
  const set = handlers.get(channel);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(message);
    } catch (err) {
      console.error(`live redis handler failed on ${channel}`, err);
    }
  }
}

export async function subscribeLive(
  channel: string,
  handler: MessageHandler,
): Promise<void> {
  const existing = handlers.get(channel);
  if (existing) {
    existing.add(handler);
    return;
  }
  handlers.set(channel, new Set([handler]));
  if (sub) {
    await sub.subscribe(channel, (message) => dispatch(channel, message));
  }
}

/** Fire-and-forget publish; a dead Redis must never fail a bid. */
export function publishLive(channel: string, message: string): void {
  if (!pub) return;
  void pub.publish(channel, message).catch((err) => {
    console.error(`live redis publish failed on ${channel}`, err);
  });
}

export async function readLiveKey(key: string): Promise<string | null> {
  if (!pub) return null;
  try {
    return await pub.get(key);
  } catch (err) {
    console.error(`live redis get failed for ${key}`, err);
    return null;
  }
}

export async function writeLiveKey(key: string, value: string): Promise<void> {
  if (!pub) return;
  try {
    await pub.set(key, value);
  } catch (err) {
    console.error(`live redis set failed for ${key}`, err);
  }
}

/** The shared pub connection, for callers that need raw command access (e.g. a rate-limit store). Null when Redis is disabled/unavailable. */
export function getLiveRedisClient(): RedisConn | null {
  return pub;
}

import rateLimit, { type Options as RateLimitOptions } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { getLiveRedisClient, liveRedisEnabled } from "../live/redis.js";

/**
 * Builds an express-rate-limit middleware. Backed by Redis (shared across
 * instances) when REDIS_URL is configured, otherwise an in-process store
 * (correct for a single instance; each horizontally-scaled instance gets its
 * own counter until Redis is configured). A Redis hiccup never fails the
 * request — `passOnStoreError` lets it through unlimited for that attempt,
 * matching the "a dead Redis must never fail a bid" rule the live transport
 * already follows.
 */
export function createRateLimiter(opts: {
  windowMs: number;
  limit: number;
  keyGenerator: RateLimitOptions["keyGenerator"];
  message: string;
}) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: opts.keyGenerator,
    store: liveRedisEnabled()
      ? new RedisStore({
          prefix: "rl:",
          sendCommand: (...args: string[]) => {
            const client = getLiveRedisClient();
            if (!client) throw new Error("live redis client not connected");
            return client.sendCommand(args);
          },
        })
      : undefined,
    handler: (_req, res) => {
      res.status(429).json({ error: opts.message });
    },
  });
}

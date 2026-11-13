import { getLiveRedisClient, liveRedisEnabled } from "../live/redis.js";

/** Short TTL for rarely-changing reference ("masters") data reads. */
export const MASTERS_CACHE_TTL_SECONDS = 60;

/** Stable key regardless of object key order, for caching a query-shaped read. */
export function cacheKey(prefix: string, params: Record<string, unknown>): string {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`);
  return parts.length > 0 ? `${prefix}:${parts.join("&")}` : prefix;
}

async function getCached<T>(key: string): Promise<T | null> {
  if (!liveRedisEnabled()) return null;
  const client = getLiveRedisClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch (err) {
    console.error(`cache get failed for ${key}`, err);
    return null;
  }
}

async function setCached(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!liveRedisEnabled()) return;
  const client = getLiveRedisClient();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    console.error(`cache set failed for ${key}`, err);
  }
}

/**
 * Cache-aside read: returns the cached value for `key` if present, otherwise
 * runs `compute`, caches its result for `ttlSeconds`, and returns it. A dead
 * or disabled Redis silently falls through to `compute` on every call.
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = await getCached<T>(key);
  if (cached != null) return cached;
  const value = await compute();
  await setCached(key, value, ttlSeconds);
  return value;
}

/** Deletes every cached key under `prefix` — called after a write so reads don't wait out the TTL. */
export async function invalidateCachePrefix(prefix: string): Promise<void> {
  if (!liveRedisEnabled()) return;
  const client = getLiveRedisClient();
  if (!client) return;
  try {
    const keys: string[] = [];
    for await (const key of client.scanIterator({ MATCH: `${prefix}*` })) {
      keys.push(key);
    }
    if (keys.length > 0) await client.del(keys);
  } catch (err) {
    console.error(`cache invalidate failed for prefix ${prefix}`, err);
  }
}

import { describe, expect, it, vi } from "vitest";
import { cacheKey, invalidateCachePrefix, withCache } from "./cache.js";

describe("cacheKey", () => {
  it("is stable regardless of key order", () => {
    expect(cacheKey("p", { page: 1, pageSize: 10 })).toBe(
      cacheKey("p", { pageSize: 10, page: 1 }),
    );
  });

  it("falls back to the bare prefix with no params", () => {
    expect(cacheKey("p", {})).toBe("p");
  });

  it("differs when a param value differs", () => {
    expect(cacheKey("p", { page: 1 })).not.toBe(cacheKey("p", { page: 2 }));
  });
});

describe("withCache / invalidateCachePrefix without Redis configured", () => {
  it("always calls compute and never throws when Redis is disabled", async () => {
    const compute = vi.fn().mockResolvedValue({ hello: "world" });
    const result = await withCache("k", 60, compute);
    expect(result).toEqual({ hello: "world" });
    expect(compute).toHaveBeenCalledTimes(1);

    // Calling again still calls compute (no in-memory fallback cache) since
    // there is nowhere to have stored the previous result without Redis.
    await withCache("k", 60, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("invalidateCachePrefix is a no-op, not an error", async () => {
    await expect(invalidateCachePrefix("cache:masters:uoms")).resolves.toBeUndefined();
  });
});

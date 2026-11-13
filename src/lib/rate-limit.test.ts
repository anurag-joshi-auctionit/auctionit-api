import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

type MockReq = { params: Record<string, string> };

function runMiddleware(
  limiter: ReturnType<typeof createRateLimiter>,
  req: MockReq,
): Promise<{ status: number; body?: unknown; passedThrough: boolean }> {
  return new Promise((resolve) => {
    let status = 200;
    const res: any = {
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        resolve({ status, body, passedThrough: false });
        return this;
      },
      setHeader() {
        return this;
      },
      getHeader() {
        return undefined;
      },
      removeHeader() {
        return this;
      },
    };
    const next = () => resolve({ status, passedThrough: true });
    (limiter as unknown as (req: unknown, res: unknown, next: () => void) => void)(
      req,
      res,
      next,
    );
  });
}

describe("createRateLimiter", () => {
  it("passes requests through while under the limit", async () => {
    const limiter = createRateLimiter({
      windowMs: 10_000,
      limit: 2,
      keyGenerator: (req: any) => req.params.lotId,
      message: "too many",
    });
    const req = { params: { lotId: "1" } };
    expect((await runMiddleware(limiter, req)).passedThrough).toBe(true);
    expect((await runMiddleware(limiter, req)).passedThrough).toBe(true);
  });

  it("rejects with 429 and the given message once the per-key limit is exceeded", async () => {
    const limiter = createRateLimiter({
      windowMs: 10_000,
      limit: 1,
      keyGenerator: (req: any) => req.params.lotId,
      message: "too many bids",
    });
    const req = { params: { lotId: "2" } };
    await runMiddleware(limiter, req);
    const second = await runMiddleware(limiter, req);
    expect(second.passedThrough).toBe(false);
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: "too many bids" });
  });

  it("keys independently per keyGenerator value", async () => {
    const limiter = createRateLimiter({
      windowMs: 10_000,
      limit: 1,
      keyGenerator: (req: any) => req.params.lotId,
      message: "too many",
    });
    await runMiddleware(limiter, { params: { lotId: "a" } });
    const other = await runMiddleware(limiter, { params: { lotId: "b" } });
    expect(other.passedThrough).toBe(true);
  });
});

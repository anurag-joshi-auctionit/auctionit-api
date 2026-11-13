import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./login-throttle.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("LoginThrottle", () => {
  it("blocks a login name after max failures and frees it when the window passes", () => {
    const c = clock();
    const th = new LoginThrottle(60_000, 3, 100, c.now);
    for (let i = 0; i < 3; i++) th.recordFailure("Alice", "1.1.1.1");
    expect(th.retryAfterMs("alice", "2.2.2.2")).toBe(60_000);
    c.advance(60_001);
    expect(th.retryAfterMs("alice", "2.2.2.2")).toBe(0);
  });

  it("blocks an IP across login names", () => {
    const c = clock();
    const th = new LoginThrottle(60_000, 100, 2, c.now);
    th.recordFailure("a", "9.9.9.9");
    th.recordFailure("b", "9.9.9.9");
    expect(th.retryAfterMs("c", "9.9.9.9")).toBeGreaterThan(0);
    expect(th.retryAfterMs("c", "8.8.8.8")).toBe(0);
  });

  it("clears the login-name counter on success", () => {
    const th = new LoginThrottle(60_000, 2, 100);
    th.recordFailure("bob", undefined);
    th.recordSuccess("bob");
    th.recordFailure("bob", undefined);
    expect(th.retryAfterMs("bob", undefined)).toBe(0);
  });
});

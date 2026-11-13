import { describe, expect, it } from "vitest";
import { settleProxies, type Contender } from "./proxy-settle.js";

// Helper: proxy contender committed at `order` (defaults to its bidder id).
const p = (bidderId: number, max: number, order = bidderId): Contender => ({
  bidderId,
  max,
  order,
  isProxy: true,
});
// Helper: the manual leader, committed at `order` (latest unless given).
const manual = (
  bidderId: number,
  amount: number,
  order = Number.MAX_SAFE_INTEGER,
): Contender => ({
  bidderId,
  max: amount,
  order,
  isProxy: false,
});

const START = 100;
const INC = 10;

describe("settleProxies", () => {
  it("does nothing when there are no proxies", () => {
    expect(settleProxies([], START, INC)).toBeNull();
    expect(settleProxies([manual(1, 200)], START, INC)).toBeNull();
  });

  it("opens a lone proxy at the start price", () => {
    expect(settleProxies([p(1, 500)], START, INC)).toEqual({
      winnerBidderId: 1,
      amount: 100,
      winnerIsProxy: true,
    });
  });

  it("opens a lone proxy at start + increment when sbpPlusIncrement is on", () => {
    // "First Bid = Start Bid Price + Increment": the forced opening bid is 110.
    expect(settleProxies([p(1, 500)], START, INC, true)).toEqual({
      winnerBidderId: 1,
      amount: 110,
      winnerIsProxy: true,
    });
  });

  it("an earlier, higher proxy matches the runner-up's limit", () => {
    // A (earlier) max 300 vs B (later) max 200 -> A holds 200 on time.
    expect(settleProxies([p(1, 300, 1), p(2, 200, 2)], START, INC)).toEqual({
      winnerBidderId: 1,
      amount: 200,
      winnerIsProxy: true,
    });
  });

  it("a later, higher proxy must beat the runner-up by one increment", () => {
    // B (earlier) max 200 vs A (later) max 300 -> A wins at 210.
    expect(settleProxies([p(1, 300, 2), p(2, 200, 1)], START, INC)).toEqual({
      winnerBidderId: 1,
      amount: 210,
      winnerIsProxy: true,
    });
  });

  it("caps a later winner's price at its own max", () => {
    // B (earlier) max 200 vs A (later) max 205: 210 > 205, so A wins at 205.
    expect(settleProxies([p(1, 205, 2), p(2, 200, 1)], START, INC)).toEqual({
      winnerBidderId: 1,
      amount: 205,
      winnerIsProxy: true,
    });
  });

  it("breaks a tie in favour of the earliest commitment, at the full amount", () => {
    expect(settleProxies([p(1, 200, 1), p(2, 200, 2)], START, INC)).toEqual({
      winnerBidderId: 1,
      amount: 200,
      winnerIsProxy: true,
    });
    // Reverse commitment order -> bidder 2 wins.
    expect(
      settleProxies([p(1, 200, 5), p(2, 200, 3)], START, INC)?.winnerBidderId,
    ).toBe(2);
  });

  it("an earlier proxy holds a later manual bid's amount", () => {
    // Proxy P max 300 set earlier; manual bid of 150 placed now -> P at 150.
    expect(settleProxies([p(1, 300, 1), manual(2, 150)], START, INC)).toEqual({
      winnerBidderId: 1,
      amount: 150,
      winnerIsProxy: true,
    });
  });

  it("a proxy set after a manual leader must beat it by one increment", () => {
    // Manual M reached 150 at t=1; proxy P max 300 set at t=2 -> P at 160.
    expect(settleProxies([p(1, 300, 2), manual(2, 150, 1)], START, INC)).toEqual({
      winnerBidderId: 1,
      amount: 160,
      winnerIsProxy: true,
    });
  });

  it("an earlier manual leader keeps the lot against a later equal proxy", () => {
    const s = settleProxies([p(1, 200, 2), manual(2, 200, 1)], START, INC);
    expect(s?.winnerBidderId).toBe(2);
    expect(s?.winnerIsProxy).toBe(false);
  });

  it("keeps the manual leader when it outranks every proxy", () => {
    const s = settleProxies([manual(2, 500), p(1, 300)], START, INC);
    expect(s?.winnerBidderId).toBe(2);
    expect(s?.winnerIsProxy).toBe(false);
  });

  it("uses the second-best of three proxies", () => {
    // 400 (earliest) / 250 / 150 -> top holds 250.
    expect(
      settleProxies([p(1, 400, 1), p(2, 250, 2), p(3, 150, 3)], START, INC),
    ).toEqual({ winnerBidderId: 1, amount: 250, winnerIsProxy: true });
  });
});

describe("settleProxies (reverse)", () => {
  const D = -1 as const;

  it("opens a lone proxy at the start price", () => {
    expect(settleProxies([p(1, 50)], START, INC, false, D)).toEqual({
      winnerBidderId: 1,
      amount: 100,
      winnerIsProxy: true,
    });
  });

  it("opens a lone proxy at start − increment when sbpPlusIncrement is on", () => {
    expect(settleProxies([p(1, 50)], START, INC, true, D)).toEqual({
      winnerBidderId: 1,
      amount: 90,
      winnerIsProxy: true,
    });
  });

  it("an earlier, lower proxy matches the runner-up's limit", () => {
    expect(settleProxies([p(1, 50, 1), p(2, 80, 2)], START, INC, false, D)).toEqual({
      winnerBidderId: 1,
      amount: 80,
      winnerIsProxy: true,
    });
  });

  it("a later, lower proxy undercuts the runner-up by one increment", () => {
    expect(settleProxies([p(1, 50, 2), p(2, 80, 1)], START, INC, false, D)).toEqual({
      winnerBidderId: 1,
      amount: 70,
      winnerIsProxy: true,
    });
  });

  it("floors a later winner's price at its own min", () => {
    // B (earlier) min 80 vs A (later) min 75: 70 < 75, so A wins at 75.
    expect(settleProxies([p(1, 75, 2), p(2, 80, 1)], START, INC, false, D)).toEqual({
      winnerBidderId: 1,
      amount: 75,
      winnerIsProxy: true,
    });
  });

  it("breaks a tie in favour of the earliest commitment, at the full amount", () => {
    expect(settleProxies([p(1, 80, 1), p(2, 80, 2)], START, INC, false, D)).toEqual({
      winnerBidderId: 1,
      amount: 80,
      winnerIsProxy: true,
    });
  });

  it("a proxy set after a manual leader undercuts it by one increment", () => {
    expect(
      settleProxies([p(1, 50, 2), manual(2, 90, 1)], START, INC, false, D),
    ).toEqual({ winnerBidderId: 1, amount: 80, winnerIsProxy: true });
  });

  it("keeps the manual leader when it outranks every proxy", () => {
    const s = settleProxies([manual(2, 50), p(1, 80)], START, INC, false, D);
    expect(s?.winnerBidderId).toBe(2);
    expect(s?.winnerIsProxy).toBe(false);
  });
});

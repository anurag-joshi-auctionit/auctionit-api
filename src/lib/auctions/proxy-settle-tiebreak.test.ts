import { describe, expect, it } from "vitest";
import { settleProxies, type Contender } from "./proxy-settle.js";

/**
 * "Earlier always wins": Contender.order is when the bidder committed to their
 * limit — settleLotProxies maps a proxy to its set time (epoch µs of
 * auction_proxy_bids.created_at) and a manual leader to its earliest bid time
 * at the winning amount.
 *
 * Ops scenario (SBP 4000, increment 200): b1 proxies 5000 at 11:20:05, b2
 * proxies 5000 at 11:20:07 → b1 holds every intermediate amount and ends at
 * 5000 as a proxy.
 */

const SBP = 4_000;
const INC = 200;

/** µs timestamp for an 11:20:ss commitment. */
const at = (ss: number) => Date.UTC(2026, 9, 19, 11, 20, ss) * 1000;

function proxy(bidderId: number, max: number, committedAt: number): Contender {
  return { bidderId, max, order: committedAt, isProxy: true };
}

function manualLeader(
  bidderId: number,
  amount: number,
  committedAt: number,
): Contender {
  return { bidderId, max: amount, order: committedAt, isProxy: false };
}

describe("settleProxies — earlier always wins", () => {
  it("ops scenario: two 5000 proxies → earlier b1 at 5000", () => {
    expect(
      settleProxies([proxy(2, 5_000, at(7)), proxy(1, 5_000, at(5))], SBP, INC),
    ).toEqual({ winnerBidderId: 1, amount: 5_000, winnerIsProxy: true });
  });

  it("ops scenario: b1's earlier 5000 proxy holds a later manual 4600", () => {
    expect(
      settleProxies(
        [proxy(1, 5_000, at(5)), manualLeader(3, 4_600, at(30))],
        SBP,
        INC,
      ),
    ).toEqual({ winnerBidderId: 1, amount: 4_600, winnerIsProxy: true });
  });

  it("five proxies at 5000 → the first one set wins at 5000", () => {
    const s = settleProxies(
      [
        proxy(4, 5_000, at(9)),
        proxy(2, 5_000, at(6)),
        proxy(5, 5_000, at(12)),
        proxy(1, 5_000, at(5)),
        proxy(3, 5_000, at(8)),
      ],
      SBP,
      INC,
    );
    expect(s).toEqual({ winnerBidderId: 1, amount: 5_000, winnerIsProxy: true });
  });

  it("a manual leader that reached 5000 first beats a later 5000 proxy", () => {
    const s = settleProxies(
      [proxy(1, 5_000, at(20)), manualLeader(2, 5_000, at(10))],
      SBP,
      INC,
    );
    expect(s?.winnerBidderId).toBe(2);
    expect(s?.winnerIsProxy).toBe(false);
  });

  it("a higher limit still wins even if set later, one increment above", () => {
    expect(
      settleProxies([proxy(1, 5_000, at(5)), proxy(2, 6_000, at(30))], SBP, INC),
    ).toEqual({ winnerBidderId: 2, amount: 5_200, winnerIsProxy: true });
  });

  it("orders by commitment time, not bidder id", () => {
    expect(
      settleProxies([proxy(1, 2_500, at(50)), proxy(2, 2_500, at(40))], SBP, INC)
        ?.winnerBidderId,
    ).toBe(2);
  });
});

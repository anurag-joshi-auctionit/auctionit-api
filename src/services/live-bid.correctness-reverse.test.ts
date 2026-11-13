import { describe, expect, it } from "vitest";
import { LiveBidMessages } from "@auctionit/messages/auctions";
import {
  MAX_INCREMENT_STEPS,
  minProxyMaxFor,
} from "@auctionit/lib/live-bid-bounds";
import { settleProxies, type Contender } from "../lib/auctions/proxy-settle.js";

/**
 * Reverse-auction mirror of live-bid.correctness.test.ts.
 * Direction = −1; winning label was formerly L1; comparisons inverted.
 */

const START = 1_000;
const INC = 100;
const D = -1 as const;

function paise(n: number): number {
  return Math.round(n * 100);
}

function nextBidMessage(opts: {
  hasBids: boolean;
  sbpPlusIncrement?: boolean;
}): string {
  if (opts.hasBids) return LiveBidMessages.BID_AT_MOST;
  return opts.sbpPlusIncrement
    ? LiveBidMessages.BID_AT_MOST_START_MINUS_INCREMENT
    : LiveBidMessages.BID_AT_MOST_START;
}

function contendersFromProxyRows(
  rows: { id: number; bidderId: number; max: number }[],
  manual?: { bidderId: number; amount: number },
): Contender[] {
  const contenders: Contender[] = rows.map((r) => ({
    bidderId: r.bidderId,
    max: r.max,
    order: r.id,
    isProxy: true,
  }));
  if (manual && !rows.some((r) => r.bidderId === manual.bidderId)) {
    contenders.push({
      bidderId: manual.bidderId,
      max: manual.amount,
      order: Number.MAX_SAFE_INTEGER,
      isProxy: false,
    });
  }
  return contenders;
}

/** Mirror of setProxyBid gates for reverse. */
function proxyMinRejection(opts: {
  maxAmount: number;
  startPrice: number;
  increment: number;
  winningAmount: number | null;
  sbpPlusIncrement?: boolean;
  ownMax?: number;
  bidLimit?: number | null;
}): string | null {
  const {
    maxAmount,
    startPrice,
    increment,
    winningAmount,
    sbpPlusIncrement = false,
    ownMax = 0,
    bidLimit = null,
  } = opts;
  const hasBids = winningAmount != null;
  const currentWinning = hasBids ? winningAmount : startPrice;
  const boundsLot = {
    bidCount: hasBids ? 1 : 0,
    currentBid: currentWinning,
    bidIncrement: increment,
    startBidPrice: startPrice,
    sbpPlusIncrement,
  };
  if (hasBids && paise(maxAmount) > paise(currentWinning)) {
    return LiveBidMessages.OUTBID_EQUAL_OR_LOWER;
  }
  const next = minProxyMaxFor(boundsLot, D);
  if (paise(maxAmount) > paise(next)) {
    return nextBidMessage({ hasBids, sbpPlusIncrement });
  }
  const cap = currentWinning - MAX_INCREMENT_STEPS * increment;
  if (bidLimit != null && maxAmount < bidLimit) {
    return LiveBidMessages.BID_LIMIT_FLOOR;
  }
  if (maxAmount < cap) {
    return LiveBidMessages.BID_FLOOR_CAP;
  }
  if ((paise(currentWinning) - paise(maxAmount)) % paise(increment) !== 0) {
    return LiveBidMessages.BID_DECREMENT;
  }
  if (ownMax > 0 && paise(maxAmount) >= paise(ownMax)) {
    return LiveBidMessages.PROXY_LOWER_ONLY;
  }
  return null;
}

function placeBidRejection(opts: {
  amount: number;
  startPrice: number;
  increment: number;
  winningAmount: number | null;
  sbpPlusIncrement?: boolean;
  bidLimit?: number | null;
}): string | null {
  const {
    amount,
    startPrice,
    increment,
    winningAmount,
    sbpPlusIncrement = false,
    bidLimit = null,
  } = opts;
  const hasBids = winningAmount != null;
  const currentWinning = hasBids ? winningAmount : startPrice;
  const next = hasBids
    ? currentWinning - increment
    : sbpPlusIncrement
      ? startPrice - increment
      : startPrice;
  if (amount > next) return nextBidMessage({ hasBids, sbpPlusIncrement });

  const cap = currentWinning - MAX_INCREMENT_STEPS * increment;
  if (bidLimit != null && amount < bidLimit) {
    return LiveBidMessages.BID_LIMIT_FLOOR;
  }
  if (amount < cap) {
    return LiveBidMessages.BID_FLOOR_CAP;
  }

  const gridBase = hasBids ? currentWinning : startPrice;
  if ((paise(gridBase) - paise(amount)) % paise(increment) !== 0) {
    return LiveBidMessages.BID_DECREMENT;
  }
  if (hasBids && paise(amount) >= paise(currentWinning)) {
    return LiveBidMessages.OUTBID_EQUAL_OR_LOWER;
  }
  return null;
}

describe("reverse Contender.order uses proxy row id", () => {
  it("equal min → lower proxy id wins", () => {
    const settlement = settleProxies(
      contendersFromProxyRows([
        { id: 100, bidderId: 7, max: 500 },
        { id: 50, bidderId: 3, max: 500 },
      ]),
      START,
      INC,
      false,
      D,
    );
    expect(settlement?.winnerBidderId).toBe(3);
    expect(settlement?.amount).toBe(500);
  });

  it("earlier proxy at winning beats a later equal manual bid", () => {
    const settlement = settleProxies(
      contendersFromProxyRows(
        [{ id: 12, bidderId: 1, max: 800 }],
        { bidderId: 2, amount: 800 },
      ),
      START,
      INC,
      false,
      D,
    );
    expect(settlement?.winnerBidderId).toBe(1);
    expect(settlement?.winnerIsProxy).toBe(true);
  });
});

describe("setProxyBid reverse — min must undercut winning + clear next bound", () => {
  it("rejects when min is above standing winning", () => {
    expect(
      proxyMinRejection({
        maxAmount: 900,
        startPrice: START,
        increment: INC,
        winningAmount: 800,
      }),
    ).toBe(LiveBidMessages.OUTBID_EQUAL_OR_LOWER);
  });

  it("rejects when min equals standing winning (must clear next)", () => {
    expect(
      proxyMinRejection({
        maxAmount: 800,
        startPrice: START,
        increment: INC,
        winningAmount: 800,
      }),
    ).toBe(LiveBidMessages.BID_AT_MOST);
  });

  it("accepts when min clears winning by one decrement", () => {
    expect(
      proxyMinRejection({
        maxAmount: 700,
        startPrice: START,
        increment: INC,
        winningAmount: 800,
      }),
    ).toBeNull();
  });

  it("on an empty lot, accepts min at start price", () => {
    expect(
      proxyMinRejection({
        maxAmount: START,
        startPrice: START,
        increment: INC,
        winningAmount: null,
      }),
    ).toBeNull();
  });

  it("proxy can only be lowered", () => {
    expect(
      proxyMinRejection({
        maxAmount: 700,
        startPrice: START,
        increment: INC,
        winningAmount: 800,
        ownMax: 600,
      }),
    ).toBe(LiveBidMessages.PROXY_LOWER_ONLY);
  });
});

describe("reverse concurrent equal placeBid", () => {
  it("second bidder at the same amount is rejected after the first wins", () => {
    let winningAmount: number | null = null;

    const first = placeBidRejection({
      amount: 900,
      startPrice: START,
      increment: INC,
      winningAmount,
    });
    expect(first).toBeNull();
    winningAmount = 900;

    const second = placeBidRejection({
      amount: 900,
      startPrice: START,
      increment: INC,
      winningAmount,
    });
    expect(second).toBe(LiveBidMessages.BID_AT_MOST);
  });

  it("second bidder must clear winning − increment", () => {
    expect(
      placeBidRejection({
        amount: 800,
        startPrice: START,
        increment: INC,
        winningAmount: 900,
      }),
    ).toBeNull();
  });
});

describe("reverse amount under the floor is told the floor, not the grid", () => {
  const underFloor = {
    startPrice: START,
    increment: INC,
    winningAmount: 10_000,
  };

  it("reports the 50× floor for a wildly low amount", () => {
    // Cap is winning − 50×inc = 5_000; 1_000 is on-grid and below that floor.
    expect(
      placeBidRejection({ ...underFloor, amount: 1_000 }),
    ).toBe(LiveBidMessages.BID_FLOOR_CAP);
  });

  it("reports bid limit floor when that is the tighter bound", () => {
    expect(
      placeBidRejection({
        ...underFloor,
        amount: 100,
        bidLimit: 500,
      }),
    ).toBe(LiveBidMessages.BID_LIMIT_FLOOR);
  });
});

describe("reverse settlement amount", () => {
  it("an earlier, lower min holds the runner-up's min", () => {
    const s = settleProxies(
      contendersFromProxyRows([
        { id: 1, bidderId: 1, max: 500 },
        { id: 2, bidderId: 2, max: 700 },
      ]),
      START,
      INC,
      false,
      D,
    );
    expect(s).toEqual({
      winnerBidderId: 1,
      amount: 700,
      winnerIsProxy: true,
    });
  });

  it("a later, lower min undercuts the runner-up by one increment", () => {
    const s = settleProxies(
      contendersFromProxyRows([
        { id: 2, bidderId: 1, max: 500 },
        { id: 1, bidderId: 2, max: 700 },
      ]),
      START,
      INC,
      false,
      D,
    );
    expect(s).toEqual({
      winnerBidderId: 1,
      amount: 600,
      winnerIsProxy: true,
    });
  });
});

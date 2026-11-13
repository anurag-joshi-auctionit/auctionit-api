import { describe, expect, it } from "vitest";
import {
  BidderPortalAuctionMessages,
  LiveBidMessages,
} from "@auctionit/messages/auctions";
import { MAX_INCREMENT_STEPS, minProxyMaxFor } from "@auctionit/lib/live-bid-bounds";
import { settleProxies, type Contender } from "../lib/auctions/proxy-settle.js";

/**
 * Correctness invariants for LiveBidService that we can assert without a DB.
 *
 * Existing *.test.ts files (e.g. auctions.attach-block.test.ts) mock DB heavily
 * rather than spinning up Postgres — so concurrent placeBid / setProxyBid
 * against a real lock are exercised via the load harness
 * (`pnpm live:load-harness`) and the seed (`pnpm seed:live-proxy-auction`).
 *
 * Contender.order semantics ("earlier always wins"): settleLotProxies maps a
 * proxy to its set time and a manual leader to when it reached the winning
 * amount. Here ascending proxy ids stand in for set times, and the pending
 * manual bid is always the latest. Dedicated cases:
 * proxy-settle-tiebreak.test.ts + proxy-settle.test.ts.
 *
 * setProxyBid winning gate: max must reach current winning (equal allowed for first-come
 * tie); formula mirrored below from live-bid.service.ts setProxyBid.
 */

const START = 1_000;
const INC = 100;
/** Tests model forward auctions (live bidding supports forward only today). */

function paise(n: number): number {
  return Math.round(n * 100);
}

/** Mirror of live-bid.service.ts minBidRejection — floor copy by lot state. */
function minBidMessage(opts: {
  hasBids: boolean;
  sbpPlusIncrement?: boolean;
}): string {
  if (opts.hasBids) return LiveBidMessages.BID_AT_LEAST;
  return opts.sbpPlusIncrement
    ? LiveBidMessages.BID_AT_LEAST_START_PLUS_INCREMENT
    : LiveBidMessages.BID_AT_LEAST_START;
}

/** Mirror of settleLotProxies contender build (proxy rows → Contender). */
function contendersFromProxyRows(
  rows: { id: number; bidderId: number; max: number }[],
  manual?: { bidderId: number; amount: number },
): Contender[] {
  const contenders: Contender[] = rows.map((r) => ({
    bidderId: r.bidderId,
    max: r.max,
    order: r.id, // stands in for the proxy's set time (ids ascend with it)
    isProxy: true,
  }));
  if (
    manual &&
    !rows.some((r) => r.bidderId === manual.bidderId)
  ) {
    contenders.push({
      bidderId: manual.bidderId,
      max: manual.amount,
      order: Number.MAX_SAFE_INTEGER,
      isProxy: false,
    });
  }
  return contenders;
}

/**
 * Mirror of setProxyBid's min-max / winning gate (live-bid.service.ts).
 * Returns the rejection reason, or null if the max would be accepted.
 * Equal max vs standing winning bid is allowed (first-come proxy tie).
 */
function proxyMaxRejection(opts: {
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
  const minMax = minProxyMaxFor(boundsLot);
  if (hasBids && paise(maxAmount) < paise(currentWinning)) {
    return LiveBidMessages.OUTBID_EQUAL_OR_HIGHER;
  }
  if (maxAmount < minMax) {
    return minBidMessage({ hasBids, sbpPlusIncrement });
  }
  // Same ceilings as placeBid: lot max bid limit first, then winning + 50×increment.
  const cap = currentWinning + MAX_INCREMENT_STEPS * increment;
  if (bidLimit != null && maxAmount > bidLimit) {
    return LiveBidMessages.BID_MAX_LIMIT;
  }
  if (maxAmount > cap) {
    return LiveBidMessages.BID_CAP;
  }
  if ((paise(maxAmount) - paise(currentWinning)) % paise(increment) !== 0) {
    return LiveBidMessages.BID_INCREMENT;
  }
  if (ownMax > 0 && paise(maxAmount) <= paise(ownMax)) {
    return LiveBidMessages.PROXY_RAISE_ONLY;
  }
  return null;
}

/**
 * Mirror of placeBid's amount gates in service order: floor, then ceiling
 * (max bid limit first, then winning + 50×increment), then the increment grid, then
 * the outbid gate after FOR UPDATE (second equal bid loses). Order is part of
 * the contract — an amount outside the range is told the bound it broke rather
 * than that it is off the grid.
 */
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
  const minNext = hasBids
    ? currentWinning + increment
    : sbpPlusIncrement
      ? startPrice + increment
      : startPrice;
  if (amount < minNext) return minBidMessage({ hasBids, sbpPlusIncrement });

  const cap = currentWinning + MAX_INCREMENT_STEPS * increment;
  // Ceiling order: max bid limit first, then winning + 50×increment.
  if (bidLimit != null && amount > bidLimit) {
    return LiveBidMessages.BID_MAX_LIMIT;
  }
  if (amount > cap) {
    return LiveBidMessages.BID_CAP;
  }

  const gridBase = hasBids ? currentWinning : startPrice;
  if ((paise(amount) - paise(gridBase)) % paise(increment) !== 0) {
    return LiveBidMessages.BID_INCREMENT;
  }
  if (hasBids && paise(amount) <= paise(currentWinning)) {
    return LiveBidMessages.OUTBID_EQUAL_OR_HIGHER;
  }
  return null;
}

describe("Contender.order is commitment order (settleLotProxies mapping)", () => {
  it("equal max → the earlier proxy wins", () => {
    // Same as proxy-settle-tiebreak.test.ts; kept here to pin the service contract.
    const settlement = settleProxies(
      contendersFromProxyRows([
        { id: 100, bidderId: 7, max: 5_000 },
        { id: 50, bidderId: 3, max: 5_000 },
      ]),
      START,
      INC,
    );
    expect(settlement?.winnerBidderId).toBe(3);
    expect(settlement?.amount).toBe(5_000);
  });

  it("an earlier proxy beats a later equal manual bid", () => {
    const settlement = settleProxies(
      contendersFromProxyRows(
        [{ id: 12, bidderId: 1, max: 2_000 }],
        { bidderId: 2, amount: 2_000 },
      ),
      START,
      INC,
    );
    expect(settlement?.winnerBidderId).toBe(1);
    expect(settlement?.winnerIsProxy).toBe(true);
  });
});

describe("setProxyBid requires max >= winning + increment once a winning bid exists", () => {
  it("rejects when max is below standing winning bid", () => {
    expect(
      proxyMaxRejection({
        maxAmount: 2_400,
        startPrice: START,
        increment: INC,
        winningAmount: 2_500,
      }),
    ).toBe(LiveBidMessages.OUTBID_EQUAL_OR_HIGHER);
  });

  it("rejects when max equals standing winning bid", () => {
    expect(
      proxyMaxRejection({
        maxAmount: 2_500,
        startPrice: START,
        increment: INC,
        winningAmount: 2_500,
      }),
    ).toBe(LiveBidMessages.BID_AT_LEAST);
  });

  it("accepts when max clears winning by one increment", () => {
    expect(
      proxyMaxRejection({
        maxAmount: 2_500,
        startPrice: START,
        increment: INC,
        winningAmount: 2_400,
      }),
    ).toBeNull();
  });

  it("on an empty lot, accepts max at start price (no sbp+inc)", () => {
    expect(
      proxyMaxRejection({
        maxAmount: START,
        startPrice: START,
        increment: INC,
        winningAmount: null,
      }),
    ).toBeNull();
  });
});

describe("concurrent equal placeBid — only one can win at a given amount", () => {
  /**
   * Under FOR UPDATE, bids on the same lot serialize. The first accepted bid
   * writes winning_amount; the second sees that winning and fails the outbid gate.
   * We simulate that sequential view here (real concurrency → live:load-harness).
   */
  it("second bidder at the same amount is rejected after the first wins", () => {
    let winningAmount: number | null = null;

    const first = placeBidRejection({
      amount: 1_500,
      startPrice: START,
      increment: INC,
      winningAmount,
    });
    expect(first).toBeNull();
    winningAmount = 1_500; // first commit

    // After FOR UPDATE serialization the second sees winning=1500; equal amount
    // fails minNext (winning + increment) — same net effect as the outbid gate.
    const second = placeBidRejection({
      amount: 1_500,
      startPrice: START,
      increment: INC,
      winningAmount,
    });
    expect(second).toBe(LiveBidMessages.BID_AT_LEAST);
  });

  it("second bidder must clear winning + increment", () => {
    expect(
      placeBidRejection({
        amount: 1_600,
        startPrice: START,
        increment: INC,
        winningAmount: 1_500,
      }),
    ).toBeNull();
  });
});

describe("an amount over the ceiling is told the ceiling, not the grid", () => {
  const overCap = { startPrice: START, increment: INC, winningAmount: 1_500 };

  it("reports the cap for a wildly high amount, even off-grid", () => {
    // A misplaced digit lands far above winning + 50 increments and off the grid.
    expect(placeBidRejection({ ...overCap, amount: 433_000_000_000_000 })).toBe(
      LiveBidMessages.BID_CAP,
    );
    expect(placeBidRejection({ ...overCap, amount: 4_300_000 })).toBe(
      LiveBidMessages.BID_CAP,
    );
  });

  it("reports the lot's max bid limit when that is the tighter bound", () => {
    expect(
      placeBidRejection({ ...overCap, amount: 4_300_050, bidLimit: 2_000 }),
    ).toBe(LiveBidMessages.BID_MAX_LIMIT);
  });

  it("reports max bid limit first when the amount exceeds both ceilings", () => {
    // Cap is winning + 50×inc = 6500; bidLimit is above the cap. Amount exceeds both.
    expect(
      placeBidRejection({ ...overCap, amount: 9_000, bidLimit: 8_000 }),
    ).toBe(LiveBidMessages.BID_MAX_LIMIT);
  });

  it("reports the 50× cap when under max bid limit but over the increment cap", () => {
    expect(
      placeBidRejection({ ...overCap, amount: 7_000, bidLimit: 8_000 }),
    ).toBe(LiveBidMessages.BID_CAP);
  });

  it("still reports the grid for an in-range amount off the increment", () => {
    expect(placeBidRejection({ ...overCap, amount: 1_650 })).toBe(
      LiveBidMessages.BID_INCREMENT,
    );
  });

  it("applies the same order to a proxy max against its bid limit", () => {
    expect(
      proxyMaxRejection({
        maxAmount: 4_300_050,
        startPrice: START,
        increment: INC,
        winningAmount: 1_500,
        bidLimit: 2_000,
      }),
    ).toBe(LiveBidMessages.BID_MAX_LIMIT);
  });

  it("rejects a proxy max over winning + 50×increment with BID_CAP", () => {
    expect(
      proxyMaxRejection({
        maxAmount: 7_000,
        startPrice: START,
        increment: INC,
        winningAmount: 1_500,
      }),
    ).toBe(LiveBidMessages.BID_CAP);
  });

  it("rejects lowering an existing proxy with PROXY_RAISE_ONLY", () => {
    expect(
      proxyMaxRejection({
        maxAmount: 2_000,
        startPrice: START,
        increment: INC,
        winningAmount: 1_500,
        ownMax: 3_000,
      }),
    ).toBe(LiveBidMessages.PROXY_RAISE_ONLY);
  });
});

/** Mirrors bidder `isOutbidLot`: only explicit yourStatus === "outbid". */
function isOutbidStanding(opts: {
  closed: boolean;
  yourStatus: "winning" | "outbid" | "none";
}) {
  if (opts.closed) return false;
  return opts.yourStatus === "outbid";
}

describe("Bid Accepted / Outbid standing (legacy bidStatus)", () => {
  it("does not show Outbid when standing is unknown (none) after a sole bid", () => {
    expect(
      isOutbidStanding({
        closed: false,
        yourStatus: "none",
      }),
    ).toBe(false);
  });

  it("shows Outbid only when server standing is outbid", () => {
    expect(
      isOutbidStanding({
        closed: false,
        yourStatus: "outbid",
      }),
    ).toBe(true);
  });

  it("does not show Outbid while this bidder is winning", () => {
    expect(
      isOutbidStanding({
        closed: false,
        yourStatus: "winning",
      }),
    ).toBe(false);
  });
});

/**
 * Mirror of placeBid / setProxyBid post-settlement standing:
 * after settleLotProxies, the HTTP response reports finalAmount + yourStatus
 * from the lot row (not the submitted amount alone).
 */
function standingAfterSettle(
  winnerBidderId: number | null,
  bidderId: number,
): "winning" | "outbid" {
  return winnerBidderId === bidderId ? "winning" : "outbid";
}

function acceptedStandingAfterProxyWar(opts: {
  bidderId: number;
  submittedAmount: number;
  startPrice: number;
  increment: number;
  rivalProxies: { id: number; bidderId: number; max: number }[];
}): { finalAmount: number; yourStatus: "winning" | "outbid" } {
  // Manual bid / new proxy max is treated as the current leader before settle,
  // matching settleLotProxies after the write that bumps winning_amount.
  const settlement = settleProxies(
    contendersFromProxyRows(opts.rivalProxies, {
      bidderId: opts.bidderId,
      amount: opts.submittedAmount,
    }),
    opts.startPrice,
    opts.increment,
  );
  if (!settlement) {
    return {
      finalAmount: opts.submittedAmount,
      yourStatus: "winning",
    };
  }
  return {
    finalAmount: settlement.amount,
    yourStatus: standingAfterSettle(settlement.winnerBidderId, opts.bidderId),
  };
}

describe("HTTP response standing after proxy settlement", () => {
  it("manual bid held by an earlier rival proxy: outbid at the bid's own amount", () => {
    // Winning was 3000; A bids 3100; B's earlier proxy max 5000 holds 3100.
    const result = acceptedStandingAfterProxyWar({
      bidderId: 10,
      submittedAmount: 3_100,
      startPrice: 3_000,
      increment: 100,
      rivalProxies: [{ id: 1, bidderId: 20, max: 5_000 }],
    });
    expect(result).toEqual({
      finalAmount: 3_100,
      yourStatus: "outbid",
    });
  });

  it("manual bid with no rival proxy: yourStatus winning and finalAmount is the bid", () => {
    const result = acceptedStandingAfterProxyWar({
      bidderId: 10,
      submittedAmount: 3_100,
      startPrice: 3_000,
      increment: 100,
      rivalProxies: [],
    });
    expect(result).toEqual({
      finalAmount: 3_100,
      yourStatus: "winning",
    });
  });

  it("setProxy below an earlier, higher proxy: outbid at its own max", () => {
    // A sets proxy max 4000 while B's earlier 5000 stands → B holds 4000.
    const settlement = settleProxies(
      contendersFromProxyRows([
        { id: 1, bidderId: 20, max: 5_000 },
        { id: 2, bidderId: 10, max: 4_000 },
      ]),
      3_000,
      100,
    );
    expect(settlement).not.toBeNull();
    expect({
      finalAmount: settlement!.amount,
      yourStatus: standingAfterSettle(settlement!.winnerBidderId, 10),
    }).toEqual({
      finalAmount: 4_000,
      yourStatus: "outbid",
    });
  });
});

/**
 * Mirror of placeBid's ledger writes: settleLotProxies records the manual bid,
 * every exhausted proxy at its limit (unless that bidder already has a row
 * there or beyond) and the winning auto-bid — in commitment order: price
 * progression, then who committed first (the manual bid is the latest).
 */
function placeBidLedger(opts: {
  manualBidderId: number;
  manualAmount: number;
  startPrice: number;
  increment: number;
  rivalProxies: { id: number; bidderId: number; max: number }[];
}): {
  rows: { bidderId: number; amount: number }[];
  winnerBidderId: number;
  winnerAmount: number;
} {
  const MANUAL = Number.MAX_SAFE_INTEGER;
  const rows = [
    { bidderId: opts.manualBidderId, amount: opts.manualAmount, order: MANUAL },
  ];
  const ordered = () =>
    rows
      .sort((a, b) => a.amount - b.amount || a.order - b.order)
      .map(({ bidderId, amount }) => ({ bidderId, amount }));
  const settlement = settleProxies(
    contendersFromProxyRows(opts.rivalProxies, {
      bidderId: opts.manualBidderId,
      amount: opts.manualAmount,
    }),
    opts.startPrice,
    opts.increment,
  );
  if (!settlement) {
    return {
      rows: ordered(),
      winnerBidderId: opts.manualBidderId,
      winnerAmount: opts.manualAmount,
    };
  }
  for (const p of opts.rivalProxies) {
    if (p.bidderId === settlement.winnerBidderId) continue;
    rows.push({ bidderId: p.bidderId, amount: p.max, order: p.id });
  }
  if (!settlement.winnerIsProxy) {
    return {
      rows: ordered(),
      winnerBidderId: opts.manualBidderId,
      winnerAmount: opts.manualAmount,
    };
  }
  const winner = opts.rivalProxies.find(
    (p) => p.bidderId === settlement.winnerBidderId,
  )!;
  rows.push({
    bidderId: settlement.winnerBidderId,
    amount: settlement.amount,
    order: winner.id,
  });
  return {
    rows: ordered(),
    winnerBidderId: settlement.winnerBidderId,
    winnerAmount: settlement.amount,
  };
}

describe("placeBid ledger — earlier always wins", () => {
  it("equal-max tie: earlier proxy holds the amount, manual recorded as losing", () => {
    // B1 proxy 50000 earlier; B2 manual 50000 → B1 wins at 50000.
    const ledger = placeBidLedger({
      manualBidderId: 2,
      manualAmount: 50_000,
      startPrice: 1_000,
      increment: 100,
      rivalProxies: [{ id: 1, bidderId: 1, max: 50_000 }],
    });
    expect(ledger.winnerBidderId).toBe(1);
    expect(ledger.winnerAmount).toBe(50_000);
    expect(ledger.rows).toEqual([
      { bidderId: 1, amount: 50_000 },
      { bidderId: 2, amount: 50_000 },
    ]);
  });

  it("earlier proxy above a manual bid matches it rather than adding an increment", () => {
    // B2 manual 3100; B1's earlier proxy max 5000 → B1 holds 3100.
    const ledger = placeBidLedger({
      manualBidderId: 2,
      manualAmount: 3_100,
      startPrice: 3_000,
      increment: 100,
      rivalProxies: [{ id: 1, bidderId: 1, max: 5_000 }],
    });
    expect(ledger.winnerBidderId).toBe(1);
    expect(ledger.winnerAmount).toBe(3_100);
    expect(ledger.rows).toEqual([
      { bidderId: 1, amount: 3_100 },
      { bidderId: 2, amount: 3_100 },
    ]);
  });

  it("two proxies over a manual bid: the earlier, higher one holds the runner-up's limit", () => {
    // Manual 5000; proxy A max 6000 (first); proxy B max 5000 → A at 5000,
    // B exhausted at 5000.
    const ledger = placeBidLedger({
      manualBidderId: 3,
      manualAmount: 5_000,
      startPrice: 1_000,
      increment: 100,
      rivalProxies: [
        { id: 1, bidderId: 1, max: 6_000 },
        { id: 2, bidderId: 2, max: 5_000 },
      ],
    });
    expect(ledger.winnerBidderId).toBe(1);
    expect(ledger.winnerAmount).toBe(5_000);
    expect(ledger.rows).toEqual([
      { bidderId: 1, amount: 5_000 },
      { bidderId: 2, amount: 5_000 },
      { bidderId: 3, amount: 5_000 },
    ]);
  });

  it("manual stays winning over a lower rival proxy, which is recorded at its limit", () => {
    const ledger = placeBidLedger({
      manualBidderId: 2,
      manualAmount: 5_000,
      startPrice: 1_000,
      increment: 100,
      rivalProxies: [{ id: 1, bidderId: 1, max: 3_000 }],
    });
    expect(ledger.winnerBidderId).toBe(2);
    expect(ledger.winnerAmount).toBe(5_000);
    expect(ledger.rows).toEqual([
      { bidderId: 1, amount: 3_000 },
      { bidderId: 2, amount: 5_000 },
    ]);
  });
});

/**
 * Mirror of setProxyBid's ledger writes (settleLotProxies with no pending
 * manual): exhausted proxies at their limit plus the winner's auto-bid, in
 * commitment order.
 */
describe("setProxyBid ledger — commitment order", () => {
  it("equal later proxy: the earlier proxy's row lands first at the tied amount", () => {
    // Boka proxied 40000 first (sitting at 31000); Vijay then proxies 40000.
    const settlement = settleProxies(
      contendersFromProxyRows([
        { id: 1, bidderId: 1, max: 40_000 },
        { id: 2, bidderId: 2, max: 40_000 },
      ]),
      30_000,
      1_000,
    );
    expect(settlement).toEqual({
      winnerBidderId: 1,
      amount: 40_000,
      winnerIsProxy: true,
    });
    const rows = [
      { bidderId: 2, amount: 40_000, order: 2 },
      { bidderId: 1, amount: settlement!.amount, order: 1 },
    ].sort((a, b) => a.amount - b.amount || a.order - b.order);
    expect(rows.map((r) => r.bidderId)).toEqual([1, 2]);
  });
});

/**
 * Mirror of insertBidLog write contract in live-bid.service.ts:
 * every placeBid / setProxyBid exit (once the lot is known) writes one
 * auction_bid_logs row; insertAutoBid also logs accepted proxy engine bids.
 */
type BidLogExpectation = {
  amount: number;
  isProxy: boolean;
  proxyAmount: number | null;
  isAccepted: boolean;
  rejectReason: string | null;
};

function placeBidLogOnReject(opts: {
  amount: number;
  reason: string;
}): BidLogExpectation {
  return {
    amount: opts.amount,
    isProxy: false,
    proxyAmount: null,
    isAccepted: false,
    rejectReason: opts.reason,
  };
}

function placeBidLogOnAccept(opts: {
  amount: number;
}): BidLogExpectation {
  return {
    amount: opts.amount,
    isProxy: false,
    proxyAmount: null,
    isAccepted: true,
    rejectReason: null,
  };
}

function setProxyBidLogOnReject(opts: {
  maxAmount: number;
  reason: string;
}): BidLogExpectation {
  return {
    amount: opts.maxAmount,
    isProxy: true,
    proxyAmount: null,
    isAccepted: false,
    rejectReason: opts.reason,
  };
}

describe("auction_bid_logs attempt audit contract", () => {
  it("rejected placeBid → one log with is_accepted=false and reason", () => {
    const amount = 500;
    const reason = placeBidRejection({
      amount,
      startPrice: START,
      increment: INC,
      winningAmount: null,
    });
    expect(reason).toBe(LiveBidMessages.BID_AT_LEAST_START);
    expect(placeBidLogOnReject({ amount, reason: reason! })).toEqual({
      amount: 500,
      isProxy: false,
      proxyAmount: null,
      isAccepted: false,
      rejectReason: LiveBidMessages.BID_AT_LEAST_START,
    });
  });

  it("accepted placeBid → log is_accepted=true matching the ledger amount", () => {
    const amount = 1_000;
    expect(
      placeBidRejection({
        amount,
        startPrice: START,
        increment: INC,
        winningAmount: null,
      }),
    ).toBeNull();
    const log = placeBidLogOnAccept({ amount });
    expect(log).toEqual({
      amount: 1_000,
      isProxy: false,
      proxyAmount: null,
      isAccepted: true,
      rejectReason: null,
    });
    // Ledger (no rival proxies) records the same manual amount.
    const ledger = placeBidLedger({
      manualBidderId: 1,
      manualAmount: amount,
      startPrice: START,
      increment: INC,
      rivalProxies: [],
    });
    expect(ledger.rows.map((r) => r.amount)).toContain(log.amount);
  });

  it("rejected setProxyBid → log with is_proxy=true, is_accepted=false", () => {
    const maxAmount = 1_000;
    const reason = proxyMaxRejection({
      maxAmount,
      startPrice: START,
      increment: INC,
      winningAmount: 2_000,
    });
    expect(reason).toBe(LiveBidMessages.OUTBID_EQUAL_OR_HIGHER);
    expect(setProxyBidLogOnReject({ maxAmount, reason: reason! })).toEqual({
      amount: 1_000,
      isProxy: true,
      proxyAmount: null,
      isAccepted: false,
      rejectReason: LiveBidMessages.OUTBID_EQUAL_OR_HIGHER,
    });
  });
});

/**
 * Mirror of IP Address Restriction (lib/auctions/ip-restriction.ts findIpClaimant
 * + the placeBid / setProxyBid / accept-tnc call sites): with the auction flag on,
 * an IP already used by another bidder in the auction — via T&C acceptance or any
 * logged bid attempt not itself rejected for IP — blocks T&C, manual and proxy.
 */
type IpAuctionState = {
  enabled: boolean;
  tnc: { bidderId: number; ip: string | null }[];
  logs: { bidderId: number; ip: string | null; rejectReason: string | null }[];
};

function ipClaimedByOther(
  s: IpAuctionState,
  bidderId: number,
  ip: string | null,
): boolean {
  if (!s.enabled || !ip) return false;
  return (
    s.tnc.some((t) => t.bidderId !== bidderId && t.ip === ip) ||
    s.logs.some(
      (l) =>
        l.bidderId !== bidderId &&
        l.ip?.split("|")[0]!.trim() === ip &&
        l.rejectReason !== LiveBidMessages.IP_RESTRICTED,
    )
  );
}

function acceptTnc(s: IpAuctionState, bidderId: number, ip: string | null) {
  if (s.tnc.some((t) => t.bidderId === bidderId)) return { ok: true as const };
  if (ipClaimedByOther(s, bidderId, ip)) {
    return {
      ok: false as const,
      status: 403,
      error: BidderPortalAuctionMessages.TNC_IP_RESTRICTED,
    };
  }
  s.tnc.push({ bidderId, ip });
  return { ok: true as const };
}

function bid(s: IpAuctionState, bidderId: number, ip: string | null) {
  const rejectReason = ipClaimedByOther(s, bidderId, ip)
    ? LiveBidMessages.IP_RESTRICTED
    : null;
  s.logs.push({ bidderId, ip, rejectReason });
  return rejectReason;
}

describe("IP Address Restriction — one IP per bidder per auction", () => {
  const A = 1;
  const B = 2;
  const IP1 = "1.1.1.1";
  const IP2 = "2.2.2.2";
  const fresh = (enabled = true): IpAuctionState => ({
    enabled,
    tnc: [],
    logs: [],
  });

  it("same bidder may accept T&C on one IP and bid from another", () => {
    const s = fresh();
    expect(acceptTnc(s, A, IP1).ok).toBe(true);
    expect(bid(s, A, IP2)).toBeNull();
    expect(bid(s, A, IP1)).toBeNull();
  });

  it("second bidder bidding from an IP another bidder bid from is rejected", () => {
    const s = fresh();
    expect(bid(s, A, IP1)).toBeNull();
    expect(bid(s, B, IP1)).toBe(LiveBidMessages.IP_RESTRICTED);
    expect(bid(s, B, IP2)).toBeNull();
  });

  it("second bidder accepting T&C on an IP already used for T&C gets 403", () => {
    const s = fresh();
    expect(acceptTnc(s, A, IP1).ok).toBe(true);
    expect(acceptTnc(s, B, IP1)).toEqual({
      ok: false,
      status: 403,
      error: BidderPortalAuctionMessages.TNC_IP_RESTRICTED,
    });
  });

  it("T&C IP of one bidder blocks another bidder's bids from it", () => {
    const s = fresh();
    acceptTnc(s, A, IP1);
    expect(bid(s, B, IP1)).toBe(LiveBidMessages.IP_RESTRICTED);
  });

  it("an IP-rejected attempt does not claim the IP", () => {
    const s = fresh();
    acceptTnc(s, A, IP1);
    expect(bid(s, B, IP1)).toBe(LiveBidMessages.IP_RESTRICTED);
    // Only A holds IP1; A is never blocked by B's rejected attempt.
    expect(bid(s, A, IP1)).toBeNull();
  });

  it("legacy seeded logs with ' | device' suffix still claim the bare IP", () => {
    const s = fresh();
    s.logs.push({ bidderId: A, ip: `${IP1} | Desktop`, rejectReason: null });
    expect(bid(s, B, IP1)).toBe(LiveBidMessages.IP_RESTRICTED);
  });

  it("missing IP is never restricted", () => {
    const s = fresh();
    acceptTnc(s, A, IP1);
    expect(bid(s, B, null)).toBeNull();
  });

  it("restriction off: shared IPs are allowed everywhere", () => {
    const s = fresh(false);
    expect(acceptTnc(s, A, IP1).ok).toBe(true);
    expect(acceptTnc(s, B, IP1).ok).toBe(true);
    expect(bid(s, A, IP1)).toBeNull();
    expect(bid(s, B, IP1)).toBeNull();
  });
});

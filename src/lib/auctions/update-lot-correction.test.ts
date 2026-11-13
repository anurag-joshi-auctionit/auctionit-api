import { describe, expect, it } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import {
  amountsEqual,
  classifyUpdateLotCase,
  CORRECTION_MAP_BEFORE_BID_MICROSECONDS,
  CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS,
  CORRECTION_TNC_BEFORE_BID_MICROSECONDS,
  isWinnerInClientBidders,
  resolveCorrectionBidCreatedAt,
  resolveSamePriceCorrectionBidCreatedAt,
} from "./update-lot-correction.js";

describe("amountsEqual", () => {
  it("compares to two decimal places", () => {
    expect(amountsEqual(100, 100.001)).toBe(true);
    expect(amountsEqual(100, 100.01)).toBe(false);
    expect(amountsEqual(null, null)).toBe(true);
    expect(amountsEqual(null, 0)).toBe(false);
  });
});

describe("classifyUpdateLotCase", () => {
  const base = {
    currentWinnerBidderId: 10,
    currentWinningAmount: 1000,
    currentQuantity: 5,
  };

  it("detects qty_only", () => {
    expect(
      classifyUpdateLotCase({
        ...base,
        nextWinnerBidderId: 10,
        nextWinningAmount: 1000,
        nextQuantity: 8,
      }),
    ).toBe("qty_only");
  });

  it("detects same_price_new_bidder", () => {
    expect(
      classifyUpdateLotCase({
        ...base,
        nextWinnerBidderId: 20,
        nextWinningAmount: 1000,
        nextQuantity: 5,
      }),
    ).toBe("same_price_new_bidder");
  });

  it("detects new_price for same bidder", () => {
    expect(
      classifyUpdateLotCase({
        ...base,
        nextWinnerBidderId: 10,
        nextWinningAmount: 1100,
        nextQuantity: 5,
      }),
    ).toBe("new_price");
  });

  it("detects new_price for different bidder", () => {
    expect(
      classifyUpdateLotCase({
        ...base,
        nextWinnerBidderId: 20,
        nextWinningAmount: 1100,
        nextQuantity: 5,
      }),
    ).toBe("new_price");
  });

  it("detects noop when nothing changes", () => {
    expect(
      classifyUpdateLotCase({
        ...base,
        nextWinnerBidderId: 10,
        nextWinningAmount: 1000,
        nextQuantity: 5,
      }),
    ).toBe("noop");
  });

  it("prefers new_price over winner change when both change", () => {
    expect(
      classifyUpdateLotCase({
        ...base,
        nextWinnerBidderId: 20,
        nextWinningAmount: 1200,
        nextQuantity: 9,
      }),
    ).toBe("new_price");
  });
});

describe("resolveCorrectionBidCreatedAt", () => {
  const effectiveEnd = new Date("2026-09-10T12:00:00.000Z");
  const extensionOn = {
    isLastBidExtension: true as boolean | null,
    lastBidExtensionWindow: 120,
    lastBidExtensionInterval: 60,
    lastBidExtensionCountMax: 5,
    lastBidExtensionCount: 0,
  };

  it("uses last bid (+10µs at write) when outside the extension window", () => {
    const last = new Date("2026-09-10T11:50:00.000Z");
    const result = resolveCorrectionBidCreatedAt({
      lastBidCreatedAt: last,
      effectiveEnd,
      ...extensionOn,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Date can't represent µs; write path applies afterLastBidMicroseconds in SQL.
      expect(result.createdAt.toISOString()).toBe(
        "2026-09-10T11:50:00.000Z",
      );
      expect(result.afterLastBidMicroseconds).toBe(
        CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS,
      );
    }
  });

  it("rejects when last bid is at or after effective end", () => {
    const last = new Date("2026-09-10T12:00:00.000Z");
    const result = resolveCorrectionBidCreatedAt({
      lastBidCreatedAt: last,
      effectiveEnd,
      ...extensionOn,
      isLastBidExtension: false,
    });
    expect(result).toEqual({
      ok: false,
      message: AuctionsValidationMessages.CORRECTION_BID_TIMESTAMP_INVALID,
    });
  });

  it("rejects when last bid would trigger last-bid extension", () => {
    // ~61s before end → inside 120s window (+10µs does not leave the window)
    const last = new Date("2026-09-10T11:58:59.000Z");
    const result = resolveCorrectionBidCreatedAt({
      lastBidCreatedAt: last,
      effectiveEnd,
      ...extensionOn,
    });
    expect(result).toEqual({
      ok: false,
      message: AuctionsValidationMessages.CORRECTION_BID_TIMESTAMP_INVALID,
    });
  });

  it("allows last bid inside the window when extension budget is exhausted", () => {
    const last = new Date("2026-09-10T11:58:59.000Z");
    const result = resolveCorrectionBidCreatedAt({
      lastBidCreatedAt: last,
      effectiveEnd,
      ...extensionOn,
      lastBidExtensionCount: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.afterLastBidMicroseconds).toBe(
        CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS,
      );
    }
  });

  it("places empty-ledger bid just before end, outside the window", () => {
    const result = resolveCorrectionBidCreatedAt({
      lastBidCreatedAt: null,
      effectiveEnd,
      ...extensionOn,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // window 120 → buffer 121s before end
      expect(result.createdAt.toISOString()).toBe(
        "2026-09-10T11:57:59.000Z",
      );
      expect(result.afterLastBidMicroseconds).toBe(0);
    }
  });

  it("rejects when effective end is missing", () => {
    const result = resolveCorrectionBidCreatedAt({
      lastBidCreatedAt: new Date("2026-09-10T11:00:00.000Z"),
      effectiveEnd: null,
      ...extensionOn,
    });
    expect(result.ok).toBe(false);
  });
});

describe("resolveSamePriceCorrectionBidCreatedAt", () => {
  it("places same-price correction 1ms before the top standing bid", () => {
    const top = new Date("2026-09-10T11:50:00.000Z");
    const result = resolveSamePriceCorrectionBidCreatedAt(top);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.createdAt.toISOString()).toBe(
        "2026-09-10T11:49:59.999Z",
      );
    }
  });
});

describe("isWinnerInClientBidders", () => {
  it("accepts winners listed on clients.bidders", () => {
    expect(isWinnerInClientBidders([10, 20, 30], 20)).toBe(true);
  });

  it("rejects winners not on clients.bidders", () => {
    expect(isWinnerInClientBidders([10, 20], 99)).toBe(false);
    expect(isWinnerInClientBidders(null, 10)).toBe(false);
    expect(isWinnerInClientBidders(undefined, 10)).toBe(false);
  });
});

describe("correction chronology offsets", () => {
  it("keeps TnC before map before the correction bid", () => {
    expect(CORRECTION_TNC_BEFORE_BID_MICROSECONDS).toBe(2);
    expect(CORRECTION_MAP_BEFORE_BID_MICROSECONDS).toBe(1);
    expect(CORRECTION_TNC_BEFORE_BID_MICROSECONDS).toBeGreaterThan(
      CORRECTION_MAP_BEFORE_BID_MICROSECONDS,
    );
  });

  it("places new-price correction 10µs after the last ledger bid", () => {
    expect(CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS).toBe(10);
  });
});

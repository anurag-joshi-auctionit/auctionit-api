import { describe, expect, it } from "vitest";
import {
  compareNoBidCandidateRank,
  rankAmongNoBidCandidates,
  shouldNoBidBumpWithStagger,
  shouldNoBidExtension,
  type NoBidExtensionInput,
} from "./no-bid-extension.js";

const base: NoBidExtensionInput = {
  lotIsActive: true,
  lotNoBidExtensionEnabled: true,
  auctionNoBidExtensionEnabled: true,
  intervalSeconds: 10,
  maxCount: 2,
  currentCount: 0,
  hasBid: false,
  secondsToEnd: 0,
  secondsToStart: -60,
};

describe("shouldNoBidExtension", () => {
  it("allows a live no-bid lot right at its effective end", () => {
    expect(shouldNoBidExtension(base)).toBe(true);
  });

  it("skips once any bid has landed", () => {
    expect(shouldNoBidExtension({ ...base, hasBid: true })).toBe(false);
  });

  it("skips inactive lots", () => {
    expect(shouldNoBidExtension({ ...base, lotIsActive: false })).toBe(false);
  });

  it("skips when the lot's no-bid flag is off", () => {
    expect(
      shouldNoBidExtension({ ...base, lotNoBidExtensionEnabled: false }),
    ).toBe(false);
  });

  it("skips when the auction's no-bid flag is off", () => {
    expect(
      shouldNoBidExtension({ ...base, auctionNoBidExtensionEnabled: false }),
    ).toBe(false);
  });

  it("treats a null auction flag as on", () => {
    expect(
      shouldNoBidExtension({ ...base, auctionNoBidExtensionEnabled: null }),
    ).toBe(true);
  });

  it("skips when no interval is configured", () => {
    expect(shouldNoBidExtension({ ...base, intervalSeconds: 0 })).toBe(false);
    expect(shouldNoBidExtension({ ...base, intervalSeconds: null })).toBe(
      false,
    );
  });

  it("skips when max count is missing or zero", () => {
    expect(shouldNoBidExtension({ ...base, maxCount: 0 })).toBe(false);
    expect(shouldNoBidExtension({ ...base, maxCount: null })).toBe(false);
  });

  it("stops after the max count is reached", () => {
    expect(shouldNoBidExtension({ ...base, currentCount: 1 })).toBe(true);
    expect(shouldNoBidExtension({ ...base, currentCount: 2 })).toBe(false);
    expect(shouldNoBidExtension({ ...base, currentCount: 3 })).toBe(false);
  });

  it("skips lots that have not started", () => {
    expect(shouldNoBidExtension({ ...base, secondsToStart: 30 })).toBe(false);
  });

  it("still picks up a lot shortly after its end (missed-tick tolerance)", () => {
    expect(shouldNoBidExtension({ ...base, secondsToEnd: -1 })).toBe(true);
    expect(shouldNoBidExtension({ ...base, secondsToEnd: -60 })).toBe(true);
  });

  it("gives up on a lot stale well past the missed-tick guard", () => {
    expect(shouldNoBidExtension({ ...base, secondsToEnd: -61 })).toBe(false);
  });

  it("evaluates at/just past the effective end, not pre-emptively", () => {
    expect(
      shouldNoBidExtension({
        ...base,
        secondsToEnd: 2,
      }),
    ).toBe(false);
    expect(
      shouldNoBidExtension({
        ...base,
        secondsToEnd: 1,
      }),
    ).toBe(true);
    expect(shouldNoBidExtension({ ...base, secondsToEnd: 0 })).toBe(true);
  });

  it("honours a custom lead window", () => {
    expect(
      shouldNoBidExtension({ ...base, secondsToEnd: 20, leadSec: 30 }),
    ).toBe(true);
    expect(
      shouldNoBidExtension({ ...base, secondsToEnd: 20, leadSec: 10 }),
    ).toBe(false);
  });
});

describe("shouldNoBidBumpWithStagger", () => {
  it("bumps every candidate when lot-stagger is off", () => {
    expect(
      shouldNoBidBumpWithStagger({
        enabled: false,
        intervalSec: 180,
        rankAmongCandidates: 2,
      }),
    ).toBe(true);
    expect(
      shouldNoBidBumpWithStagger({
        enabled: true,
        intervalSec: 0,
        rankAmongCandidates: 3,
      }),
    ).toBe(true);
  });

  it("bumps only the earliest candidate when lot-stagger is on", () => {
    expect(
      shouldNoBidBumpWithStagger({
        enabled: true,
        intervalSec: 180,
        rankAmongCandidates: 1,
      }),
    ).toBe(true);
    expect(
      shouldNoBidBumpWithStagger({
        enabled: true,
        intervalSec: 180,
        rankAmongCandidates: 2,
      }),
    ).toBe(false);
    expect(
      shouldNoBidBumpWithStagger({
        enabled: true,
        intervalSec: 180,
        rankAmongCandidates: 3,
      }),
    ).toBe(false);
  });
});

describe("compareNoBidCandidateRank", () => {
  const t11 = Date.parse("2026-08-26T05:30:00.000Z");

  it("ranks by effective end before display_order", () => {
    const closingSoon = {
      lotId: 2,
      effectiveEndMs: t11,
      displayOrder: 2,
    };
    const laterEndLowerOrder = {
      lotId: 1,
      effectiveEndMs: t11 + 60_000,
      displayOrder: 1,
    };
    expect(
      compareNoBidCandidateRank(closingSoon, laterEndLowerOrder),
    ).toBeLessThan(0);
    expect(rankAmongNoBidCandidates(2, [laterEndLowerOrder, closingSoon])).toBe(
      1,
    );
    expect(rankAmongNoBidCandidates(1, [laterEndLowerOrder, closingSoon])).toBe(
      2,
    );
  });

  it("breaks ties on display_order then lot id", () => {
    const a = { lotId: 1, effectiveEndMs: t11, displayOrder: 1 };
    const b = { lotId: 2, effectiveEndMs: t11, displayOrder: 2 };
    expect(compareNoBidCandidateRank(a, b)).toBeLessThan(0);
    expect(rankAmongNoBidCandidates(1, [b, a])).toBe(1);
  });
});

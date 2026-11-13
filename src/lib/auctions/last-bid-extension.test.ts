import { describe, expect, it } from "vitest";
import {
  shouldLastBidExtension,
  type LastBidExtensionInput,
} from "./last-bid-extension.js";

const base: LastBidExtensionInput = {
  isLastBidExtension: true,
  lastBidExtensionWindow: 120,
  lastBidExtensionInterval: 180,
  lastBidExtensionCountMax: 5,
  lastBidExtensionCount: 0,
  timeLeftSec: 60,
  hasEffectiveEnd: true,
};

describe("shouldLastBidExtension", () => {
  it("extends when a bid lands inside the last-bid window", () => {
    expect(shouldLastBidExtension(base)).toBe(true);
  });

  it("never extends a reopened lot", () => {
    expect(shouldLastBidExtension({ ...base, isReopened: true })).toBe(false);
    expect(shouldLastBidExtension({ ...base, isReopened: false })).toBe(true);
  });

  it("skips when last-bid extension is off", () => {
    expect(
      shouldLastBidExtension({ ...base, isLastBidExtension: false }),
    ).toBe(false);
    expect(
      shouldLastBidExtension({ ...base, isLastBidExtension: null }),
    ).toBe(false);
  });

  it("skips when the bid is outside the last-bid window", () => {
    expect(shouldLastBidExtension({ ...base, timeLeftSec: 121 })).toBe(false);
  });

  it("skips a lot that already closed", () => {
    expect(shouldLastBidExtension({ ...base, timeLeftSec: 0 })).toBe(false);
    expect(shouldLastBidExtension({ ...base, timeLeftSec: -1 })).toBe(false);
  });

  it("skips when interval or window is missing / non-positive", () => {
    expect(
      shouldLastBidExtension({ ...base, lastBidExtensionWindow: 0 }),
    ).toBe(false);
    expect(
      shouldLastBidExtension({ ...base, lastBidExtensionWindow: null }),
    ).toBe(false);
    expect(
      shouldLastBidExtension({ ...base, lastBidExtensionInterval: 0 }),
    ).toBe(false);
    expect(
      shouldLastBidExtension({ ...base, lastBidExtensionInterval: null }),
    ).toBe(false);
  });

  it("treats null / zero max extensions as off (not unlimited)", () => {
    expect(
      shouldLastBidExtension({ ...base, lastBidExtensionCountMax: null }),
    ).toBe(false);
    expect(
      shouldLastBidExtension({ ...base, lastBidExtensionCountMax: 0 }),
    ).toBe(false);
  });

  it("stops once the lot has used its maximum extensions", () => {
    expect(
      shouldLastBidExtension({ ...base, lastBidExtensionCount: 4 }),
    ).toBe(true);
    expect(
      shouldLastBidExtension({ ...base, lastBidExtensionCount: 5 }),
    ).toBe(false);
  });

  it("skips when there is no effective end to extend", () => {
    expect(
      shouldLastBidExtension({ ...base, hasEffectiveEnd: false }),
    ).toBe(false);
  });
});

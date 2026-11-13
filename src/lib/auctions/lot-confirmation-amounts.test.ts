import { describe, expect, it } from "vitest";
import {
  formatPercent,
  formatQty,
  lotConfirmationLineAmounts,
} from "./lot-confirmation-amounts.js";

describe("lotConfirmationLineAmounts", () => {
  it("matches the sample letter math (28100 × 18% GST, 2% TCS, qty 25)", () => {
    const amounts = lotConfirmationLineAmounts({
      winningAmount: 28100,
      quantity: 25,
      gstPercentage: 18,
      tcsPercentage: 2,
    });
    expect(amounts.gstAmount).toBe(5058);
    expect(amounts.pricePlusGst).toBe(33158);
    expect(amounts.tcsAmount).toBeCloseTo(663.16, 2);
    expect(amounts.unitWithTax).toBeCloseTo(33821.16, 2);
    expect(amounts.lineTotal).toBeCloseTo(845529, 2);
  });

  it("skips TCS when the rate is 0", () => {
    const amounts = lotConfirmationLineAmounts({
      winningAmount: 100,
      quantity: 2,
      gstPercentage: 18,
      tcsPercentage: 0,
    });
    expect(amounts.gstAmount).toBe(18);
    expect(amounts.tcsAmount).toBe(0);
    expect(amounts.unitWithTax).toBe(118);
    expect(amounts.lineTotal).toBe(236);
  });
});

describe("formatPercent", () => {
  it("renders integers without trailing zeros", () => {
    expect(formatPercent(18)).toBe("18");
  });

  it("keeps non-integers to 3 decimals", () => {
    expect(formatPercent(2.5)).toBe("2.5");
  });
});

describe("formatQty", () => {
  it("formats with en-IN grouping", () => {
    expect(formatQty(25000)).toBe("25,000");
  });
});

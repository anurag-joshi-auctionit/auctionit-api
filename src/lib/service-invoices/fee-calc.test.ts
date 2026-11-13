import { describe, expect, it } from "vitest";
import { computeFeeTotals } from "./fee-calc.js";

describe("computeFeeTotals round-off", () => {
  it("keeps whole subtotal with zero round-off", () => {
    const fees = computeFeeTotals({
      serviceFeeType: "service_percentage",
      serviceFeeValue: 0.05,
      totalQuantity: 10,
      totalAmount: 1000,
      gstPercent: 18,
    });

    expect(fees.serviceFeeAmount).toBe(50);
    expect(fees.gstAmount).toBe(9);
    expect(fees.grandTotal).toBe(59);
    expect(fees.roundOff).toBe(0);
  });

  it("stores actual grand total and round-off for UI ceil", () => {
    // fixed 100.25 + 18% GST (18.045 → 18.05) = 118.30; UI ceil 119, roundOff 0.70
    const fees = computeFeeTotals({
      serviceFeeType: "fixed_amount",
      serviceFeeValue: 100.25,
      totalQuantity: 0,
      totalAmount: 0,
      gstPercent: 18,
    });

    expect(fees.serviceFeeAmount).toBe(100.25);
    expect(fees.gstAmount).toBe(18.05);
    expect(fees.grandTotal).toBe(118.3);
    expect(fees.roundOff).toBe(0.7);
    expect(
      Number((fees.grandTotal + fees.roundOff).toFixed(2)),
    ).toBe(119);
  });

  it("keeps 3dp actual grand with round-off to next whole", () => {
    // fixed 33.3335 → round3 33.334; gst 18% of raw = 6.00003 → 6.00
    // actual 39.334; UI ceil 40, roundOff 0.67
    const fees = computeFeeTotals({
      serviceFeeType: "fixed_amount",
      serviceFeeValue: 33.3335,
      totalQuantity: 0,
      totalAmount: 0,
      gstPercent: 18,
    });

    expect(fees.serviceFeeAmount).toBe(33.334);
    expect(fees.gstAmount).toBe(6);
    expect(fees.grandTotal).toBe(39.334);
    expect(fees.roundOff).toBe(0.67);
    expect(
      Number((fees.grandTotal + fees.roundOff).toFixed(2)),
    ).toBe(40);
  });
});

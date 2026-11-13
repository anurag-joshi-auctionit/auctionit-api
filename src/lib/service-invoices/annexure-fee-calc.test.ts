import { describe, expect, it } from "vitest";
import { computeFeeTotals } from "./fee-calc.js";
import { aggregateAnnexureTotals } from "./annexure-totals.js";

describe("annexure totals → fee calc", () => {
  it("derives service/gst/grand from summed line amounts", () => {
    const totals = aggregateAnnexureTotals([
      {
        lineOrder: 1,
        auctionNumber: "A1",
        auctionDate: "2026-01-01",
        lotNumber: "1",
        product: "Scrap",
        approvedQty: 10,
        uom: "MT",
        rankLabel: "Winning",
        winningPrice: 100,
        bidderName: "Bidder",
        liftedQty: 10,
        amount: 1000,
      },
    ]);

    const fees = computeFeeTotals({
      serviceFeeType: "service_percentage",
      serviceFeeValue: 0.05,
      totalQuantity: totals.totalQuantity,
      totalAmount: totals.totalAmount,
      gstPercent: 18,
    });

    expect(totals).toEqual({ totalQuantity: 10, totalAmount: 1000 });
    expect(fees.serviceFeeAmount).toBe(50);
    expect(fees.gstAmount).toBe(9);
    expect(fees.roundOff).toBe(0);
    expect(fees.grandTotal).toBe(59);
  });

  it("uses pmt fee against total lifted quantity", () => {
    const totals = aggregateAnnexureTotals([
      {
        lineOrder: 1,
        auctionNumber: "A1",
        auctionDate: "2026-01-01",
        lotNumber: "1",
        product: "Scrap",
        approvedQty: 10,
        uom: "MT",
        rankLabel: "Winning",
        winningPrice: 100,
        bidderName: "Bidder",
        liftedQty: 4,
        amount: 400,
      },
      {
        lineOrder: 2,
        auctionNumber: "A2",
        auctionDate: "2026-01-02",
        lotNumber: "2",
        product: "Scrap",
        approvedQty: 5,
        uom: "MT",
        rankLabel: "Winning",
        winningPrice: 80,
        bidderName: "Bidder",
        liftedQty: 1,
        amount: 80,
      },
    ]);

    const fees = computeFeeTotals({
      serviceFeeType: "pmt",
      serviceFeeValue: 200,
      totalQuantity: totals.totalQuantity,
      totalAmount: totals.totalAmount,
      gstPercent: 18,
    });

    expect(totals.totalQuantity).toBe(5);
    expect(fees.serviceFeeAmount).toBe(1000);
    expect(fees.gstAmount).toBe(180);
    expect(fees.roundOff).toBe(0);
    expect(fees.grandTotal).toBe(1180);
  });
});

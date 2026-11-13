import { describe, expect, it } from "vitest";
import {
  buildAnnexurePdf,
  formatAnnexureDisplayDate,
  formatServiceChargesLine,
  resolveAnnexureColumnWidths,
} from "./annexure-pdf.js";
import type { ServiceInvoiceAnnexureLine } from "./annexure-types.js";

describe("formatAnnexureDisplayDate", () => {
  it("formats ISO date as DD MMM YYYY", () => {
    expect(formatAnnexureDisplayDate("2026-01-15")).toBe("15 Jan 2026");
  });

  it("pads single-digit day", () => {
    expect(formatAnnexureDisplayDate("2025-02-04")).toBe("04 Feb 2025");
  });

  it("returns empty for blank", () => {
    expect(formatAnnexureDisplayDate("")).toBe("");
  });
});

describe("resolveAnnexureColumnWidths", () => {
  it("fills content width exactly", () => {
    const width = 539.28;
    const cols = resolveAnnexureColumnWidths(width);
    const sum = cols.reduce((s, c) => s + c.width, 0);
    expect(sum).toBeCloseTo(width, 2);
  });

  it("keeps fixed widths for auction, lot, product, party", () => {
    const cols = resolveAnnexureColumnWidths(539.28);
    expect(cols.find((c) => c.key === "auctionNumber")?.fixedWidth).toBe(60);
    expect(cols.find((c) => c.key === "lotNumber")?.fixedWidth).toBe(90);
    expect(cols.find((c) => c.key === "product")?.fixedWidth).toBe(60);
    expect(cols.find((c) => c.key === "party")?.fixedWidth).toBe(60);
    expect(cols.find((c) => c.key === "auctionDate")?.fixedWidth).toBeUndefined();
  });
});

describe("formatServiceChargesLine", () => {
  it("formats service_percentage", () => {
    expect(formatServiceChargesLine("service_percentage", 0.75, 14388.85)).toBe(
      "Service Charges @ INR 0.75% = INR 14,388.85",
    );
  });

  it("formats pmt", () => {
    expect(formatServiceChargesLine("pmt", 100, 2500.5)).toBe(
      "Service Charges @ INR 100/MT = INR 2,500.50",
    );
  });

  it("formats fixed_amount", () => {
    expect(formatServiceChargesLine("fixed_amount", 5000, 5000)).toBe(
      "Service Charges @ INR 5000 = INR 5,000.00",
    );
  });
});

describe("buildAnnexurePdf", () => {
  const sampleLine: ServiceInvoiceAnnexureLine = {
    lineOrder: 1,
    auctionNumber: "A-100",
    auctionDate: "2026-01-15",
    lotNumber: "1",
    product: "Scrap",
    approvedQty: 10,
    uom: "MT",
    rankLabel: "Winning",
    winningPrice: 1000,
    bidderName: "Bidder Co",
    liftedQty: 8,
    amount: 8000,
  };

  it("produces a non-empty PDF buffer with %PDF header", async () => {
    const buffer = await buildAnnexurePdf({
      lines: [sampleLine],
      clientName: "Acme Steel",
      plantLocationName: "Plant A",
      totalQuantity: 8,
      totalAmount: 8000,
      serviceFeeType: "service_percentage",
      serviceFeeValue: 0.05,
      serviceFeeAmount: 400,
    });
    expect(buffer.length).toBeGreaterThan(100);
    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  it("keeps a short annexure on a single page (no blank auto pages)", async () => {
    const buffer = await buildAnnexurePdf({
      lines: [sampleLine, { ...sampleLine, lineOrder: 2, lotNumber: "2" }],
      clientName: "Acme Steel",
      plantLocationName: "Plant A",
      totalQuantity: 16,
      totalAmount: 16000,
      serviceFeeType: "fixed_amount",
      serviceFeeValue: 5000,
      serviceFeeAmount: 5000,
    });
    const body = buffer.toString("latin1");
    const pageObjects = body.match(/\/Type\s*\/Page(?![s\w])/g) ?? [];
    expect(pageObjects.length).toBe(1);
  });

  it("builds PDF for pmt fee type", async () => {
    const buffer = await buildAnnexurePdf({
      lines: [sampleLine],
      clientName: "Acme Steel",
      plantLocationName: null,
      totalQuantity: 8,
      totalAmount: 8000,
      serviceFeeType: "pmt",
      serviceFeeValue: 50,
      serviceFeeAmount: 400,
    });
    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  it("builds PDF for fixed_amount with no line items", async () => {
    const buffer = await buildAnnexurePdf({
      lines: [],
      clientName: "Acme Steel",
      plantLocationName: "Plant A",
      totalQuantity: 0,
      totalAmount: 0,
      serviceFeeType: "fixed_amount",
      serviceFeeValue: 5000,
      serviceFeeAmount: 5000,
    });
    expect(buffer.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  it("builds a larger PDF when lines are present vs empty", async () => {
    const empty = await buildAnnexurePdf({
      lines: [],
      clientName: "Acme Steel",
      plantLocationName: "Plant A",
      totalQuantity: 0,
      totalAmount: 0,
      serviceFeeType: "fixed_amount",
      serviceFeeValue: 5000,
      serviceFeeAmount: 5000,
    });
    const withLines = await buildAnnexurePdf({
      lines: [sampleLine, { ...sampleLine, lineOrder: 2, lotNumber: "2" }],
      clientName: "Acme Steel",
      plantLocationName: "Plant A",
      totalQuantity: 16,
      totalAmount: 16000,
      serviceFeeType: "service_percentage",
      serviceFeeValue: 0.05,
      serviceFeeAmount: 800,
    });
    expect(withLines.length).toBeGreaterThan(empty.length);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildLotConfirmationPdf,
  resolveLotConfirmationColumnWidths,
} from "./lot-confirmation-pdf.js";

describe("resolveLotConfirmationColumnWidths", () => {
  it("fills content width exactly", () => {
    const width = 539.28;
    const cols = resolveLotConfirmationColumnWidths("GST", width);
    const sum = cols.reduce((s, c) => s + c.width, 0);
    expect(sum).toBeCloseTo(width, 2);
  });

  it("places Confirmed At before Lifting Period with auto width", () => {
    const cols = resolveLotConfirmationColumnWidths("GST", 539.28);
    const keys = cols.map((c) => c.key);
    expect(keys.indexOf("confirmedAt")).toBe(keys.indexOf("lifting") - 1);
    expect(cols.find((c) => c.key === "confirmedAt")?.fixedWidth).toBe(30);
  });
});

describe("buildLotConfirmationPdf", () => {
  it("produces a non-empty PDF buffer with %PDF header", async () => {
    const buffer = await buildLotConfirmationPdf({
      auctionType: "forward",
      auctionNumber: "AUC-100",
      auctionDate: "2026-08-08",
      clientName: "Manaksia Limited",
      taxLabel: "GST",
      bidderCompany: "Janta Scrap Collector",
      bidderAddress: "Brajalalchak, Dakshinchak, Haldia",
      bidderCityPin: "Haldia 721654",
      bidderEmail: "winner@example.com",
      bidderPhone: "9999999999",
      bidderPan: "ABCDE1234F",
      bidderGstin: "19ABCDE1234F1Z5",
      paymentContacts: ["Plant POC (9999999999) For Plant A"],
      letterDate: "13 Aug 2026",
      lots: [
        {
          lotNumber: "1",
          plantLocationName: "Haldia",
          reviewedAt: "2026-08-13",
          materialLiftingDays: 7,
          quantity: 25,
          uom: "MT",
          winningAmount: 28100,
          gstPercentage: 18,
          tcsPercentage: 2,
        },
        {
          lotNumber: "2",
          plantLocationName: "Haldia",
          reviewedAt: "2026-08-13",
          materialLiftingDays: 7,
          quantity: 25,
          uom: "MT",
          winningAmount: 28100,
          gstPercentage: 18,
          tcsPercentage: 2,
        },
      ],
    });
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});

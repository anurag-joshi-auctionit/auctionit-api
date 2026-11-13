import { describe, expect, it } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import {
  assertDisplayOrderAvailable,
  dedupeRowsByDisplayOrder,
  normalizeDisplayOrderKey,
} from "./auction-lot-display-order.js";
import type { ParsedAuctionLotImportRow } from "./auction-lot-import-parse.js";

const importRowData = {
  lotNumber: "L1",
  materialLiftingDays: 1,
  plantLocation: "A",
  materialLocation: "B",
  gstPercentage: 5 as const,
  tcsPercentage: 1,
  startBidPrice: 100,
  bidLimit: 200,
  bidIncrement: 10,
  lotStartTime: "10:00:00",
  lotEndTime: "12:00:00",
  loadingScope: "buyer" as const,
  displayOrder: 1,
  remark: "r",
  itemId: 1,
  quantity: 1,
  uom: "MT",
  benchmarkMaterial: null as string | null,
  materialName: "Scrap",
  materialDescription: null as string | null,
};

function row(
  rowNumber: number,
  overrides: Partial<typeof importRowData> = {},
): ParsedAuctionLotImportRow {
  return {
    rowNumber,
    data: { ...importRowData, ...overrides },
  };
}

describe("normalizeDisplayOrderKey", () => {
  it("treats 1, 1.0, and string 1.000 as the same key", () => {
    expect(normalizeDisplayOrderKey(1)).toBe("1");
    expect(normalizeDisplayOrderKey(1.0)).toBe("1");
    expect(normalizeDisplayOrderKey("1.000")).toBe("1");
  });

  it("preserves fractional orders", () => {
    expect(normalizeDisplayOrderKey(1.5)).toBe("1.5");
    expect(normalizeDisplayOrderKey("1.500")).toBe("1.5");
  });
});

describe("assertDisplayOrderAvailable (create/patch)", () => {
  it("rejects when display order is already taken (create)", () => {
    const existing = new Set([normalizeDisplayOrderKey(1)]);
    expect(() => assertDisplayOrderAvailable(existing, 1)).toThrow(
      AuctionsValidationMessages.DISPLAY_ORDER_DUPLICATE_IN_AUCTION,
    );
  });

  it("allows a free display order (create)", () => {
    const existing = new Set([normalizeDisplayOrderKey(1)]);
    expect(() => assertDisplayOrderAvailable(existing, 2)).not.toThrow();
  });

  it("allows keeping own order when current lot is excluded (patch)", () => {
    // Patch loads keys with excludeLotId, so the lot's own order is absent.
    const existingExcludingSelf = new Set([normalizeDisplayOrderKey(2)]);
    expect(() =>
      assertDisplayOrderAvailable(existingExcludingSelf, 1),
    ).not.toThrow();
  });

  it("rejects patching to another lot's display order", () => {
    const existingExcludingSelf = new Set([normalizeDisplayOrderKey(2)]);
    expect(() => assertDisplayOrderAvailable(existingExcludingSelf, 2)).toThrow(
      AuctionsValidationMessages.DISPLAY_ORDER_DUPLICATE_IN_AUCTION,
    );
  });
});

describe("dedupeRowsByDisplayOrder", () => {
  it("keeps the later row when display orders collide in-file", () => {
    const { unique, skippedIssues } = dedupeRowsByDisplayOrder([
      row(2, { lotNumber: "A", displayOrder: 1 }),
      row(3, { lotNumber: "B", displayOrder: 1 }),
      row(4, { lotNumber: "C", displayOrder: 2 }),
    ]);

    expect(unique.map((r) => r.data.lotNumber)).toEqual(["B", "C"]);
    expect(skippedIssues).toEqual([
      {
        rowNumber: 2,
        kind: "skipped",
        reason: AuctionsValidationMessages.DUPLICATE_DISPLAY_ORDER_IN_FILE(3),
      },
    ]);
  });

  it("collapses 1 and 1.0 as the same display order", () => {
    const { unique, skippedIssues } = dedupeRowsByDisplayOrder([
      row(2, { lotNumber: "A", displayOrder: 1 }),
      row(3, { lotNumber: "B", displayOrder: 1.0 }),
    ]);

    expect(unique).toHaveLength(1);
    expect(unique[0]?.data.lotNumber).toBe("B");
    expect(skippedIssues).toHaveLength(1);
  });
});

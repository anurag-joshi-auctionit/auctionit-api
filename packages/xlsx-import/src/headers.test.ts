import { describe, expect, it } from "vitest";
import {
  buildHeaderIndexMap,
  labelForImportHeaderKey,
  normalizeImportHeader,
} from "./headers.js";
import { parseYesNo, castImportNumber } from "./coerce.js";

describe("normalizeImportHeader", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeImportHeader("  Lot Number  ")).toBe("lot number");
  });

  it("strips slashes", () => {
    expect(normalizeImportHeader("BidIncrement/Decrement")).toBe(
      "bidincrementdecrement",
    );
  });
});

describe("buildHeaderIndexMap", () => {
  it("maps camelCase keys (legacy string list)", () => {
    const { columnIndexByKey, missingKeys, missingLabels } = buildHeaderIndexMap(
      ["bidderId", "bidderName", "extra"],
      ["bidderId", "bidderName", "emdAmount"],
    );
    expect(columnIndexByKey.get("bidderId")).toBe(0);
    expect(columnIndexByKey.get("bidderName")).toBe(1);
    expect(missingKeys).toEqual(["emdAmount"]);
    expect(missingLabels).toEqual(["emdAmount"]);
  });

  it("maps display labels to internal keys and accepts legacy keys", () => {
    const defs = [
      { key: "bidderId", label: "Bidder ID" },
      { key: "bidderName", label: "Bidder Name" },
      { key: "emdAmount", label: "EMD Amount" },
    ] as const;

    const byLabel = buildHeaderIndexMap(
      ["Bidder ID", "Bidder Name", "EMD Amount"],
      defs,
    );
    expect(byLabel.columnIndexByKey.get("bidderId")).toBe(0);
    expect(byLabel.missingKeys).toEqual([]);

    const byLegacy = buildHeaderIndexMap(
      ["bidderId", "bidderName", "emdAmount"],
      defs,
    );
    expect(byLegacy.columnIndexByKey.get("emdAmount")).toBe(2);
    expect(byLegacy.missingLabels).toEqual([]);
  });

  it("reports missingLabels for user-facing errors", () => {
    const { missingKeys, missingLabels } = buildHeaderIndexMap(
      ["Bidder ID"],
      [
        { key: "bidderId", label: "Bidder ID" },
        { key: "emdAmount", label: "EMD Amount" },
      ],
    );
    expect(missingKeys).toEqual(["emdAmount"]);
    expect(missingLabels).toEqual(["EMD Amount"]);
  });
});

describe("labelForImportHeaderKey", () => {
  it("returns label or falls back to key", () => {
    expect(
      labelForImportHeaderKey(
        [{ key: "lotNumber", label: "Lot Number", width: 16 }],
        "lotNumber",
      ),
    ).toBe("Lot Number");
    expect(
      labelForImportHeaderKey(
        [{ key: "lotNumber", label: "Lot Number", width: 16 }],
        "unknown",
      ),
    ).toBe("unknown");
  });
});

describe("parseYesNo", () => {
  it("parses common yes/no forms", () => {
    expect(parseYesNo("y")).toBe(true);
    expect(parseYesNo("NO")).toBe(false);
    expect(parseYesNo("maybe")).toBeNull();
  });
});

describe("castImportNumber", () => {
  it("parses numbers and rejects empty", () => {
    expect(castImportNumber("1,234.5")).toBe(1234.5);
    expect(castImportNumber("")).toBeNull();
  });
});

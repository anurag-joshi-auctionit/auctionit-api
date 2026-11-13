import { describe, expect, it } from "vitest";
import { parseLotBidderMapImportSheetRows } from "./parse.js";

const headers = [
  "bidderId",
  "bidderName",
  "lotDisplayOrders",
  "emdDisplayOrders",
  "isEmdWithClient",
];

const labelHeaders = [
  "Bidder ID",
  "Bidder Name",
  "Lot Display Orders",
  "EMD Display Orders",
  "Is EMD With Client",
];

describe("parseLotBidderMapImportSheetRows", () => {
  it("parses camelCase headers including emdDisplayOrders", () => {
    const result = parseLotBidderMapImportSheetRows([
      headers,
      [42, "Acme", "1, 2.5", "1, 2", "y"],
    ]);
    expect(result.headerError).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      bidderId: 42,
      bidderName: "Acme",
      lotDisplayOrders: [1, 2.5],
      emdDisplayOrders: [1, 2],
      isEmdWithClientRaw: "y",
    });
  });

  it("parses display label headers", () => {
    const result = parseLotBidderMapImportSheetRows([
      labelHeaders,
      [42, "Acme", "1", "1", "y"],
    ]);
    expect(result.headerError).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.bidderId).toBe(42);
  });

  it("still parses older files that carry the dropped Block Status / EMD Amount columns", () => {
    const result = parseLotBidderMapImportSheetRows([
      [...labelHeaders, "Block Status", "EMD Amount"],
      [42, "Acme", "1", "1", "n", "p", 1000],
    ]);
    expect(result.headerError).toBeNull();
    expect(result.rows[0]).toMatchObject({ bidderId: 42, isEmdWithClientRaw: "n" });
  });

  it("rejects missing required headers", () => {
    const result = parseLotBidderMapImportSheetRows([
      ["bidder_id", "bidder_name"],
      [1, "x"],
    ]);
    expect(result.rows).toEqual([]);
    expect(result.headerError).toMatch(/Missing required column/);
    expect(result.headerError).toMatch(/Bidder ID/);
    expect(result.headerError).toMatch(/EMD Display Orders/);
  });

  it("skips blank data rows", () => {
    const result = parseLotBidderMapImportSheetRows([
      headers,
      ["", "", "", "", "", "", ""],
      [7, "Beta", "3", "1", "n", "e", 50],
    ]);
    expect(result.headerError).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.bidderId).toBe(7);
    expect(result.rows[0]?.emdDisplayOrders).toEqual([1]);
  });

  it("allows blank lotDisplayOrders while parsing emdDisplayOrders", () => {
    const result = parseLotBidderMapImportSheetRows([
      headers,
      [9, "Gamma", "", "1", "y", "", null],
    ]);
    expect(result.headerError).toBeNull();
    expect(result.rows[0]).toMatchObject({
      lotDisplayOrders: [],
      emdDisplayOrders: [1],
    });
  });
});

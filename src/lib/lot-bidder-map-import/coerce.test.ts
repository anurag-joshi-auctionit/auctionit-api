import { describe, expect, it } from "vitest";
import { dedupeLotBidderMapImportRows } from "./coerce.js";

function row(
  rowNumber: number,
  overrides: Partial<{
    bidderId: number | null;
    lotDisplayOrders: number[];
    emdDisplayOrders: number[];
    isEmdWithClientRaw: string;
    blockStatusRaw: string;
    emdAmount: number | null;
  }> = {},
) {
  return {
    rowNumber,
    bidderId: 1258,
    lotDisplayOrders: [1],
    emdDisplayOrders: [2],
    isEmdWithClientRaw: "n",
    blockStatusRaw: "f",
    emdAmount: 10_000,
    ...overrides,
  };
}

describe("dedupeLotBidderMapImportRows", () => {
  it("keeps a single row and reports duplicates as skipped", () => {
    const result = dedupeLotBidderMapImportRows([
      row(2),
      row(3),
      row(4),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rowNumber).toBe(2);
    expect(result.skipped).toEqual([
      { rowNumber: 3, keptRowNumber: 2 },
      { rowNumber: 4, keptRowNumber: 2 },
    ]);
  });

  it("treats lot/emd order permutations as the same key", () => {
    const result = dedupeLotBidderMapImportRows([
      row(2, { lotDisplayOrders: [1, 2], emdDisplayOrders: [1, 2] }),
      row(3, { lotDisplayOrders: [2, 1], emdDisplayOrders: [2, 1] }),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toEqual([{ rowNumber: 3, keptRowNumber: 2 }]);
  });

  it("keeps distinct payloads for the same bidder", () => {
    const result = dedupeLotBidderMapImportRows([
      row(2, { lotDisplayOrders: [1] }),
      row(3, { lotDisplayOrders: [2] }),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });
});

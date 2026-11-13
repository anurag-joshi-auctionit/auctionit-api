import { describe, expect, it } from "vitest";
import { normalizeLotBidderRemoveSelection } from "./lot-bidder-map-remove.js";

describe("normalizeLotBidderRemoveSelection", () => {
  it("dedupes ids and computes requested pair count", () => {
    expect(normalizeLotBidderRemoveSelection([1, 1, 2], [10, 20, 10])).toEqual({
      bidderIds: [1, 2],
      lotIds: [10, 20],
      requestedPairs: 4,
    });
  });

  it("returns null when either side is empty", () => {
    expect(normalizeLotBidderRemoveSelection([], [1])).toBeNull();
    expect(normalizeLotBidderRemoveSelection([1], [])).toBeNull();
  });

  it("filters non-positive ids", () => {
    expect(normalizeLotBidderRemoveSelection([0, -1, 3], [5])).toEqual({
      bidderIds: [3],
      lotIds: [5],
      requestedPairs: 1,
    });
  });
});

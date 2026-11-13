import { describe, expect, it } from "vitest";
import { withBidderRanks, type RankedBid } from "./rank.js";

const ranked = (bidderId: number, rank: number): RankedBid => ({
  lotId: 1,
  bidderId,
  rank,
  best: 0,
});

describe("withBidderRanks", () => {
  it("attaches ranks and orders rank-first", () => {
    const rows = [{ bidderId: 10 }, { bidderId: 20 }, { bidderId: 30 }];
    const out = withBidderRanks(rows, [ranked(30, 1), ranked(10, 2), ranked(20, 3)]);
    expect(out).toEqual([
      { bidderId: 30, rank: 1 },
      { bidderId: 10, rank: 2 },
      { bidderId: 20, rank: 3 },
    ]);
  });

  it("puts unranked rows last in their incoming order", () => {
    const rows = [{ bidderId: 1 }, { bidderId: 2 }, { bidderId: 3 }];
    const out = withBidderRanks(rows, [ranked(3, 1)]);
    expect(out.map((r) => [r.bidderId, r.rank])).toEqual([
      [3, 1],
      [1, null],
      [2, null],
    ]);
  });

  it("returns empty for empty input", () => {
    expect(withBidderRanks([], [ranked(1, 1)])).toEqual([]);
  });
});

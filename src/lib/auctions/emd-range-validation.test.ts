import { describe, expect, it } from "vitest";
import {
  unmappedLots,
  unmappedSelectedLotIds,
} from "./emd-range-validation.js";

describe("unmappedSelectedLotIds (attach / import gate)", () => {
  const lots = [
    { lotId: 10, lotNumber: "Mapped", displayOrder: 1 },
    { lotId: 20, lotNumber: "Unmapped", displayOrder: 3 },
    { lotId: 30, lotNumber: "NoOrder", displayOrder: null },
  ];
  const ranges = [{ lotDisplayOrderFrom: 1, lotDisplayOrderTo: 2 }];

  it("allows selecting only mapped lots when other lots are unmapped", () => {
    expect(unmappedSelectedLotIds(lots, ranges, [10])).toEqual([]);
  });

  it("rejects uncovered and missing-display-order lots in a selection", () => {
    expect(unmappedSelectedLotIds(lots, ranges, [10, 20, 30])).toEqual([
      20, 30,
    ]);
  });

  it("rejects a selection that is only unmapped lots", () => {
    expect(unmappedSelectedLotIds(lots, ranges, [20])).toEqual([20]);
  });

  it("matches unmappedLots ids for the auction", () => {
    const unmappedIds = unmappedLots(lots, ranges).map((l) => l.lotId);
    expect(unmappedIds).toEqual([20, 30]);
    expect(unmappedSelectedLotIds(lots, ranges, unmappedIds)).toEqual(
      unmappedIds,
    );
  });
});

import { describe, expect, it } from "vitest";
import { splitNullRangeHold } from "./split-null-range-hold.js";

const ranges = [
  { id: 15890, displayOrder: 1, emdAmount: 10000, lotDisplayOrderFrom: 1, lotDisplayOrderTo: 1 },
  { id: 15891, displayOrder: 2, emdAmount: 125000, lotDisplayOrderFrom: 2, lotDisplayOrderTo: 2 },
];
const base = {
  amountHeld: 135000,
  amountReleased: 0,
  amountForfeited: 0,
  ranges,
  wonLots: [
    { lotId: 378094, displayOrder: 1 },
    { lotId: 378095, displayOrder: 2 },
  ],
};

describe("splitNullRangeHold", () => {
  it("splits a hold whose ranges sum to the consolidated EMD", () => {
    expect(splitNullRangeHold(base)).toEqual([
      { emdRangeId: 15890, amount: 10000, lotIds: [378094] },
      { emdRangeId: 15891, amount: 125000, lotIds: [378095] },
    ]);
  });

  it("skips a hold that already has a release or forfeiture", () => {
    expect(splitNullRangeHold({ ...base, amountReleased: 10000 })).toBeNull();
    expect(splitNullRangeHold({ ...base, amountForfeited: 1 })).toBeNull();
  });

  it("skips when a lot is outside every range", () => {
    expect(
      splitNullRangeHold({ ...base, wonLots: [...base.wonLots, { lotId: 9, displayOrder: 7 }] }),
    ).toBeNull();
  });

  it("skips when the ranges fall short of the held amount", () => {
    expect(splitNullRangeHold({ ...base, amountHeld: 140000 })).toBeNull();
  });
});

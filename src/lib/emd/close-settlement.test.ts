import { describe, expect, it } from "vitest";
import {
  holdWrites,
  planCloseSettlement,
  releasedLotIds,
  type SettlementRange,
} from "./close-settlement.js";

const ranges: SettlementRange[] = [
  { id: 1, displayOrder: 1, emdAmount: 60000, lotDisplayOrderFrom: 1, lotDisplayOrderTo: 6 },
  { id: 2, displayOrder: 2, emdAmount: 10000, lotDisplayOrderFrom: 7, lotDisplayOrderTo: 7 },
  { id: 3, displayOrder: 3, emdAmount: 20000, lotDisplayOrderFrom: 8, lotDisplayOrderTo: 10 },
];

const lot = (n: number) => ({ lotId: 100 + n, displayOrder: n });

describe("planCloseSettlement", () => {
  it("keeps only the won single-lot range blocked", () => {
    const r = planCloseSettlement({ blockedBalance: 80000, ranges, wonLots: [lot(7)] });
    expect(r.holds).toEqual([{ emdRangeId: 2, amount: 10000, lotIds: [107] }]);
    expect(r.releaseAmount).toBe(70000);
  });

  it("keeps the whole consolidated range blocked for a lot inside it", () => {
    const r = planCloseSettlement({ blockedBalance: 80000, ranges, wonLots: [lot(5)] });
    expect(r.holds).toEqual([{ emdRangeId: 1, amount: 60000, lotIds: [105] }]);
    expect(r.releaseAmount).toBe(20000);
  });

  it("keeps every won range blocked", () => {
    const r = planCloseSettlement({ blockedBalance: 100000, ranges, wonLots: [lot(2), lot(7), lot(9)] });
    expect(r.holds.map((h) => [h.emdRangeId, h.amount])).toEqual([
      [1, 60000],
      [2, 10000],
      [3, 20000],
    ]);
    expect(r.releaseAmount).toBe(10000);
  });

  it("caps the hold at the block, allocating in EMD display order", () => {
    const r = planCloseSettlement({ blockedBalance: 65000, ranges, wonLots: [lot(2), lot(7), lot(9)] });
    expect(r.holds.map((h) => [h.emdRangeId, h.amount])).toEqual([
      [1, 60000],
      [2, 5000],
    ]);
    expect(r.releaseAmount).toBe(0);
  });

  it("releases everything when nothing is won", () => {
    const r = planCloseSettlement({ blockedBalance: 80000, ranges, wonLots: [] });
    expect(r.holds).toEqual([]);
    expect(r.releaseAmount).toBe(80000);
  });

  it("keeps the whole block without ranges", () => {
    const r = planCloseSettlement({ blockedBalance: 5000, ranges: [], wonLots: [lot(1), lot(2)] });
    expect(r.holds).toEqual([{ emdRangeId: null, amount: 5000, lotIds: [101, 102] }]);
    expect(r.releaseAmount).toBe(0);
  });

  it("keeps the whole block when a won lot is outside every range", () => {
    const r = planCloseSettlement({ blockedBalance: 5000, ranges, wonLots: [lot(5), lot(12)] });
    expect(r.holds).toEqual([{ emdRangeId: null, amount: 5000, lotIds: [105, 112] }]);
  });

  it("does nothing without a block", () => {
    expect(planCloseSettlement({ blockedBalance: 0, ranges, wonLots: [lot(1)] })).toEqual({
      holds: [],
      releaseAmount: 0,
    });
  });

  it("is idempotent: planning again from the held block changes nothing", () => {
    const first = planCloseSettlement({ blockedBalance: 80000, ranges, wonLots: [lot(7)] });
    const again = planCloseSettlement({
      blockedBalance: 80000 - first.releaseAmount,
      ranges,
      wonLots: [lot(7)],
    });
    expect(again.holds).toEqual(first.holds);
    expect(again.releaseAmount).toBe(0);
  });

  it("releases the range of a reopened lot that went to another bidder", () => {
    // Held 3,000 (ranges 2 and 3); the bidder now wins only the range-2 lot.
    const r = planCloseSettlement({
      blockedBalance: 30000,
      ranges,
      wonLots: [lot(7)],
    });
    expect(r.holds).toEqual([{ emdRangeId: 2, amount: 10000, lotIds: [107] }]);
    expect(r.releaseAmount).toBe(20000);
  });

  it("does not hold a range already released or forfeited again", () => {
    const r = planCloseSettlement({
      blockedBalance: 30000,
      ranges,
      wonLots: [lot(7), lot(9)],
      consumedRangeIds: new Set([2]),
    });
    expect(r.holds).toEqual([{ emdRangeId: 3, amount: 20000, lotIds: [109] }]);
    expect(r.releaseAmount).toBe(10000);
  });
});

describe("holdWrites", () => {
  it("inserts a hold for a new target", () => {
    const w = holdWrites({
      targets: [{ emdRangeId: 2, amount: 10000, lotIds: [107] }],
      existing: [],
    });
    expect(w).toEqual([{ emdRangeId: 2, amountHeld: 10000, lotIds: [107], isNew: true }]);
  });

  it("moves an existing hold to the new target, keeping what was already released", () => {
    const w = holdWrites({
      targets: [{ emdRangeId: 2, amount: 10000, lotIds: [107, 108] }],
      existing: [{ emdRangeId: 2, amountReleased: 2000, amountForfeited: 0 }],
    });
    expect(w).toEqual([{ emdRangeId: 2, amountHeld: 12000, lotIds: [107, 108], isNew: false }]);
  });

  it("drops a range that is no longer a target to zero held", () => {
    const w = holdWrites({
      targets: [],
      existing: [{ emdRangeId: 1, amountReleased: 0, amountForfeited: 0 }],
    });
    expect(w).toEqual([{ emdRangeId: 1, amountHeld: 0, lotIds: [], isNew: false }]);
  });
});

describe("releasedLotIds", () => {
  const wallet = [lot(1), lot(5), lot(7), lot(9)];

  it("lists every wallet lot when nothing was won", () => {
    expect(releasedLotIds(wallet, [], [], ranges)).toEqual([101, 105, 107, 109]);
  });

  it("leaves off won lots and lots in a range that stays blocked", () => {
    expect(
      releasedLotIds(wallet, [lot(5)], [{ emdRangeId: 1 }], ranges),
    ).toEqual([107, 109]);
  });

  it("lists nothing when the whole block is held without a range", () => {
    expect(releasedLotIds(wallet, [lot(5)], [{ emdRangeId: null }], ranges)).toEqual([]);
  });
});

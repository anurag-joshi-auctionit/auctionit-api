import { describe, expect, it } from "vitest";
import { planCascadeFromAnchor, shouldStagger } from "./stagger.js";

describe("shouldStagger", () => {
  it("staggers only when enabled with a positive interval", () => {
    expect(shouldStagger(false, 30)).toBe(false);
    expect(shouldStagger(true, 30)).toBe(true);
    expect(shouldStagger(true, 0)).toBe(false);
    expect(shouldStagger(true, null)).toBe(false);
    expect(shouldStagger(null, 30)).toBe(false);
  });
});

/** Fixed "11:00" anchor end for case arithmetic (epoch ms). */
const T11 = Date.parse("2026-08-26T05:30:00.000Z"); // 11:00 IST
const sec = (s: number) => s * 1000;
const min = (m: number) => m * 60_000;

function fiveLotsAt(endMs: number) {
  return [1, 2, 3, 4, 5].map((n) => ({
    id: n,
    displayOrder: n,
    effectiveEndMs: endMs,
  }));
}

describe("planCascadeFromAnchor — sequential chain", () => {
  // Cases assume L1 already has its post-extension end; cascade chains from it.
  // nowMs is well before any lot end so nothing is treated as closed.

  it("case 1: last-bid 2m + stagger 3m chains L2..L5 from L1", () => {
    const l1End = T11 + min(2); // 11:02
    const lots = [
      { id: 1, displayOrder: 1, effectiveEndMs: l1End },
      ...fiveLotsAt(T11).slice(1),
    ];
    const plan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 180,
      anchorLotId: 1,
      anchorEndMs: l1End,
      lots,
      nowMs: T11 - min(1),
    });
    expect(plan.map((p) => [p.lotId, p.newEndsAtMs])).toEqual([
      [2, T11 + min(5)], // 11:05
      [3, T11 + min(8)], // 11:08
      [4, T11 + min(11)],
      [5, T11 + min(14)],
    ]);
  });

  it("case 2: last-bid 2m + stagger 30s", () => {
    const l1End = T11 + min(2); // 11:02
    const lots = [
      { id: 1, displayOrder: 1, effectiveEndMs: l1End },
      ...fiveLotsAt(T11).slice(1),
    ];
    const plan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 30,
      anchorLotId: 1,
      anchorEndMs: l1End,
      lots,
      nowMs: T11 - min(1),
    });
    expect(plan.map((p) => [p.lotId, p.newEndsAtMs])).toEqual([
      [2, T11 + min(2) + sec(30)], // 11:02:30
      [3, T11 + min(3)], // 11:03
      [4, T11 + min(3) + sec(30)],
      [5, T11 + min(4)],
    ]);
  });

  it("case 3: after L1 chain, L3 last-bid rebuilds L4..L5 from L3", () => {
    // After L1 last-bid + 30s stagger:
    const afterL1 = [
      { id: 1, displayOrder: 1, effectiveEndMs: T11 + min(2) },
      { id: 2, displayOrder: 2, effectiveEndMs: T11 + min(2) + sec(30) },
      { id: 3, displayOrder: 3, effectiveEndMs: T11 + min(3) },
      { id: 4, displayOrder: 4, effectiveEndMs: T11 + min(3) + sec(30) },
      { id: 5, displayOrder: 5, effectiveEndMs: T11 + min(4) },
    ];
    // L3 last-bid: 11:03 + 2m = 11:05
    const l3End = T11 + min(5);
    const lots = afterL1.map((l) =>
      l.id === 3 ? { ...l, effectiveEndMs: l3End } : l,
    );
    const plan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 30,
      anchorLotId: 3,
      anchorEndMs: l3End,
      lots,
      nowMs: T11 - min(1),
    });
    expect(plan.map((p) => [p.lotId, p.newEndsAtMs])).toEqual([
      [4, T11 + min(5) + sec(30)], // 11:05:30
      [5, T11 + min(6)], // 11:06
    ]);
  });

  it("case 4: no-bid 2m + stagger 3m, then second no-bid rebuilds", () => {
    const firstL1 = T11 + min(2); // 11:02
    const firstPlan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 180,
      anchorLotId: 1,
      anchorEndMs: firstL1,
      lots: [
        { id: 1, displayOrder: 1, effectiveEndMs: firstL1 },
        ...fiveLotsAt(T11).slice(1),
      ],
      nowMs: T11,
    });
    expect(firstPlan.map((p) => p.newEndsAtMs)).toEqual([
      T11 + min(5),
      T11 + min(8),
      T11 + min(11),
      T11 + min(14),
    ]);

    // Second no-bid at 11:02: L1 → 11:04, rebuild chain
    const secondL1 = T11 + min(4);
    const afterFirst = [
      { id: 1, displayOrder: 1, effectiveEndMs: secondL1 },
      { id: 2, displayOrder: 2, effectiveEndMs: T11 + min(5) },
      { id: 3, displayOrder: 3, effectiveEndMs: T11 + min(8) },
      { id: 4, displayOrder: 4, effectiveEndMs: T11 + min(11) },
      { id: 5, displayOrder: 5, effectiveEndMs: T11 + min(14) },
    ];
    const secondPlan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 180,
      anchorLotId: 1,
      anchorEndMs: secondL1,
      lots: afterFirst,
      nowMs: T11 + min(2),
    });
    expect(secondPlan.map((p) => [p.lotId, p.newEndsAtMs])).toEqual([
      [2, T11 + min(7)],
      [3, T11 + min(10)],
      [4, T11 + min(13)],
      [5, T11 + min(16)],
    ]);
  });

  it("standalone: chains from current end without changing the anchor", () => {
    const plan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 180,
      anchorLotId: 1,
      anchorEndMs: T11,
      lots: fiveLotsAt(T11),
      nowMs: T11 - sec(3),
    });
    expect(plan.map((p) => [p.lotId, p.newEndsAtMs])).toEqual([
      [2, T11 + min(3)],
      [3, T11 + min(6)],
      [4, T11 + min(9)],
      [5, T11 + min(12)],
    ]);
  });

  it("is idempotent on re-tick once the chain is already applied", () => {
    const chained = [
      { id: 1, displayOrder: 1, effectiveEndMs: T11 },
      { id: 2, displayOrder: 2, effectiveEndMs: T11 + min(3) },
      { id: 3, displayOrder: 3, effectiveEndMs: T11 + min(6) },
      { id: 4, displayOrder: 4, effectiveEndMs: T11 + min(9) },
      { id: 5, displayOrder: 5, effectiveEndMs: T11 + min(12) },
    ];
    expect(
      planCascadeFromAnchor({
        enabled: true,
        intervalSec: 180,
        anchorLotId: 1,
        anchorEndMs: T11,
        lots: chained,
        nowMs: T11 - sec(3),
      }),
    ).toEqual([]);
  });

  it("does not move earlier lots (only subsequent)", () => {
    const lots = fiveLotsAt(T11);
    const plan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 180,
      anchorLotId: 3,
      anchorEndMs: T11 + min(2),
      lots: lots.map((l) =>
        l.id === 3 ? { ...l, effectiveEndMs: T11 + min(2) } : l,
      ),
      nowMs: T11 - min(1),
    });
    expect(plan.every((p) => p.lotId > 3)).toBe(true);
    expect(plan.map((p) => p.lotId)).toEqual([4, 5]);
  });

  it("never moves a later lot earlier than its current end", () => {
    // L2 already ends at 11:10; chain from L1@11:02 + 3m would be 11:05 — keep 11:10
    const lots = [
      { id: 1, displayOrder: 1, effectiveEndMs: T11 + min(2) },
      { id: 2, displayOrder: 2, effectiveEndMs: T11 + min(10) },
      { id: 3, displayOrder: 3, effectiveEndMs: T11 },
    ];
    const plan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 180,
      anchorLotId: 1,
      anchorEndMs: T11 + min(2),
      lots,
      nowMs: T11 - min(1),
    });
    // L2 skipped (already past chained target); L3 chains from L2's 11:10
    expect(plan.map((p) => [p.lotId, p.newEndsAtMs])).toEqual([
      [3, T11 + min(13)],
    ]);
  });

  it("skips closed lots without reopening them", () => {
    const lots = [
      { id: 1, displayOrder: 1, effectiveEndMs: T11 + min(2) },
      { id: 2, displayOrder: 2, effectiveEndMs: T11 - min(1) }, // closed
      { id: 3, displayOrder: 3, effectiveEndMs: T11 },
    ];
    const plan = planCascadeFromAnchor({
      enabled: true,
      intervalSec: 180,
      anchorLotId: 1,
      anchorEndMs: T11 + min(2),
      lots,
      nowMs: T11,
    });
    expect(plan.every((p) => p.lotId !== 2)).toBe(true);
    // L3 chains from closed L2's end: (T11 - 1m) + 3m = T11 + 2m
    expect(plan).toEqual([
      {
        lotId: 3,
        oldEndsAtMs: T11,
        newEndsAtMs: T11 + min(2),
        extendedBySec: 120,
      },
    ]);
  });

  it("plans nothing when disabled", () => {
    expect(
      planCascadeFromAnchor({
        enabled: false,
        intervalSec: 180,
        anchorLotId: 1,
        anchorEndMs: T11,
        lots: fiveLotsAt(T11),
      }),
    ).toEqual([]);
  });
});

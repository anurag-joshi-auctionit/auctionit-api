import { describe, expect, it } from "vitest";
import {
  assertLotEmdDisplayOrdersInSync,
  computeBidderEmdRequired,
  computeBidderEmdRequiredFromEmdDisplayOrders,
  expandLotsFromEmdRanges,
  resolveEmdRangesByDisplayOrders,
  validateBlockRow,
} from "./emd-required.js";

const RANGE = {
  displayOrder: 1,
  lotDisplayOrderFrom: 1,
  lotDisplayOrderTo: 2,
  emdAmount: 100,
};

const allLots = [
  { lotId: 10, displayOrder: 1 },
  { lotId: 20, displayOrder: 2 },
];

const RANGE1 = {
  displayOrder: 1,
  lotDisplayOrderFrom: 1,
  lotDisplayOrderTo: 5,
  emdAmount: 10_000,
};
const RANGE2 = {
  displayOrder: 2,
  lotDisplayOrderFrom: 6,
  lotDisplayOrderTo: 10,
  emdAmount: 20_000,
};

const caseLots = [
  { lotId: 1, displayOrder: 1 },
  { lotId: 2, displayOrder: 2 },
  { lotId: 3, displayOrder: 3 },
  { lotId: 4, displayOrder: 4 },
  { lotId: 5, displayOrder: 5 },
  { lotId: 6, displayOrder: 6 },
  { lotId: 7, displayOrder: 7 },
  { lotId: 8, displayOrder: 8 },
  { lotId: 9, displayOrder: 9 },
  { lotId: 10, displayOrder: 10 },
];

const RANGE_A = {
  displayOrder: 1,
  lotDisplayOrderFrom: 1,
  lotDisplayOrderTo: 3,
  emdAmount: 5_000,
};
const RANGE_B = {
  displayOrder: 2,
  lotDisplayOrderFrom: 4,
  lotDisplayOrderTo: 6,
  emdAmount: 20_000,
};

const exampleLots = [
  { lotId: 1, displayOrder: 1 },
  { lotId: 2, displayOrder: 2 },
  { lotId: 3, displayOrder: 3 },
  { lotId: 4, displayOrder: 4 },
  { lotId: 5, displayOrder: 5 },
  { lotId: 6, displayOrder: 6 },
];

describe("computeBidderEmdRequired — per-lot ranges with a consolidated cap", () => {
  // R1 lots 1-2 = 1,000; R2 lot 3 = 2,000; R3 lots 4-7 = 3,000; R4 lot 8 = 5,000.
  const ranges = [
    { displayOrder: 1, lotDisplayOrderFrom: 1, lotDisplayOrderTo: 2, emdAmount: 1_000 },
    { displayOrder: 2, lotDisplayOrderFrom: 3, lotDisplayOrderTo: 3, emdAmount: 2_000 },
    { displayOrder: 3, lotDisplayOrderFrom: 4, lotDisplayOrderTo: 7, emdAmount: 3_000 },
    { displayOrder: 4, lotDisplayOrderFrom: 8, lotDisplayOrderTo: 8, emdAmount: 5_000 },
  ];
  const lots = (...orders: number[]) =>
    orders.map((o) => ({ lotId: o, displayOrder: o }));
  const required = (...orders: number[]) =>
    computeBidderEmdRequired({
      selectedLots: lots(...orders),
      ranges,
      consolidatedEmd: 10_000,
    }).emdRequired;

  it("sums the covering ranges", () => {
    expect(required(1, 3, 4)).toBe(6_000);
    expect(required(1, 4)).toBe(4_000);
    expect(required(3)).toBe(2_000);
  });

  it("charges a shared range once", () => {
    expect(required(1, 2)).toBe(1_000);
  });

  it("caps at the consolidated EMD", () => {
    expect(required(1, 3, 4, 8)).toBe(10_000);
    // Dropping lot 8 releases 4,000, not its 5,000 range amount.
    expect(required(1, 3, 4, 8) - required(1, 3, 4)).toBe(4_000);
  });
});

describe("computeBidderEmdRequired", () => {
  it("falls back to consolidated EMD when no ranges are configured", () => {
    const result = computeBidderEmdRequired({
      selectedLots: [allLots[0]!],
      ranges: [],
      consolidatedEmd: 500,
    });
    expect(result.emdRequired).toBe(500);
  });

  it("charges the full range amount for a single resolved emd_display_order", () => {
    const result = computeBidderEmdRequired({
      selectedLots: [exampleLots[1]!], // display order 2 → emd 1
      ranges: [RANGE_A, RANGE_B],
      consolidatedEmd: null,
    });
    expect(result.emdRequired).toBe(5_000);
  });

  it("dedupes emd_display_order when multiple lots share one range", () => {
    const result = computeBidderEmdRequired({
      selectedLots: exampleLots.slice(0, 3), // display orders 1–3 → emd 1
      ranges: [RANGE_A, RANGE_B],
      consolidatedEmd: null,
    });
    expect(result.emdRequired).toBe(5_000);
  });

  it("sums unique emd_display_order amounts across ranges", () => {
    const result = computeBidderEmdRequired({
      selectedLots: [exampleLots[0]!, exampleLots[4]!], // 1 and 5 → emd {1,2}
      ranges: [RANGE_A, RANGE_B],
      consolidatedEmd: null,
    });
    expect(result.emdRequired).toBe(25_000);
  });

  it("caps the set-sum at the consolidated ceiling", () => {
    const result = computeBidderEmdRequired({
      selectedLots: [exampleLots[0]!, exampleLots[4]!], // sum 25000
      ranges: [RANGE_A, RANGE_B],
      consolidatedEmd: 15_000,
    });
    expect(result.emdRequired).toBe(15_000);
    expect(result.rangeEmdSum).toBe(25_000);
  });

  it("caps a single-range requirement at the consolidated ceiling", () => {
    const result = computeBidderEmdRequired({
      selectedLots: allLots,
      ranges: [RANGE],
      consolidatedEmd: 40,
    });
    expect(result.emdRequired).toBe(40);
  });

  it("reports lots that fall outside every range", () => {
    const result = computeBidderEmdRequired({
      selectedLots: [{ lotId: 30, displayOrder: 9 }],
      ranges: [RANGE],
      consolidatedEmd: null,
    });
    expect(result.uncoveredLotIds).toContain(30);
  });
});

describe("resolveEmdRangesByDisplayOrders", () => {
  it("resolves known orders and reports missing ones", () => {
    const result = resolveEmdRangesByDisplayOrders([1, 2, 9], [RANGE1, RANGE2]);
    expect(result.ranges).toHaveLength(2);
    expect(result.missingOrders).toEqual([9]);
  });

  it("dedupes repeated orders", () => {
    const result = resolveEmdRangesByDisplayOrders([1, 1], [RANGE1, RANGE2]);
    expect(result.ranges).toHaveLength(1);
    expect(result.missingOrders).toEqual([]);
  });
});

describe("assertLotEmdDisplayOrdersInSync", () => {
  it("accepts case 1 lots under emd 1", () => {
    expect(
      assertLotEmdDisplayOrdersInSync({
        lotOrders: [2, 3],
        emdRanges: [RANGE1],
      }).ok,
    ).toBe(true);
  });

  it("accepts case 2 lots spanning emd 1 and 2", () => {
    expect(
      assertLotEmdDisplayOrdersInSync({
        lotOrders: [2, 3, 7, 8],
        emdRanges: [RANGE1, RANGE2],
      }).ok,
    ).toBe(true);
  });

  it("rejects a lot outside listed emd ranges", () => {
    const result = assertLotEmdDisplayOrdersInSync({
      lotOrders: [2, 7],
      emdRanges: [RANGE1],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Lot display order 7/);
  });

  it("rejects an unused emd display order", () => {
    const result = assertLotEmdDisplayOrdersInSync({
      lotOrders: [2, 3],
      emdRanges: [RANGE1, RANGE2],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/emdDisplayOrder 2/);
  });
});

describe("expandLotsFromEmdRanges", () => {
  it("expands case 3 to all lots in emd range 1", () => {
    const lotIds = expandLotsFromEmdRanges({
      allLots: caseLots,
      emdRanges: [RANGE1],
    });
    expect(lotIds).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("computeBidderEmdRequiredFromEmdDisplayOrders", () => {
  it("sums full range amounts for case 1", () => {
    expect(
      computeBidderEmdRequiredFromEmdDisplayOrders({
        ranges: [RANGE1],
        consolidatedEmd: null,
      }).emdRequired,
    ).toBe(10_000);
  });

  it("sums full range amounts for case 2", () => {
    expect(
      computeBidderEmdRequiredFromEmdDisplayOrders({
        ranges: [RANGE1, RANGE2],
        consolidatedEmd: null,
      }).emdRequired,
    ).toBe(30_000);
  });

  it("caps at consolidated ceiling", () => {
    expect(
      computeBidderEmdRequiredFromEmdDisplayOrders({
        ranges: [RANGE1, RANGE2],
        consolidatedEmd: 15_000,
      }).emdRequired,
    ).toBe(15_000);
  });
});

describe("validateBlockRow", () => {
  it("skips validation when EMD is with client", () => {
    expect(
      validateBlockRow({
        isEmdWithClient: true,
        emdRequired: 100,
        emdAvailable: 0,
      }),
    ).toBeNull();
  });

  it("accepts a full block the wallet can cover", () => {
    expect(
      validateBlockRow({
        isEmdWithClient: false,
        emdRequired: 100,
        emdAvailable: 100,
      }),
    ).toBeNull();
  });

  it("accepts a zero requirement (nothing to block)", () => {
    expect(
      validateBlockRow({
        isEmdWithClient: false,
        emdRequired: 0,
        emdAvailable: 0,
      }),
    ).toBeNull();
  });

  it("rejects blocking more than the wallet balance", () => {
    expect(
      validateBlockRow({
        isEmdWithClient: false,
        emdRequired: 100,
        emdAvailable: 30,
      }),
    ).toMatch(/insufficient/i);
  });
});

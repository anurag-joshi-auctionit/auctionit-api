import { describe, expect, it } from "vitest";
import { EmdErrorMessages, EmdValidationMessages } from "@auctionit/messages/emd";
import {
  planWinningLotRelease,
  type HoldingLot,
  type HoldingWinning,
} from "./winning-lot-release.js";

const lot = (lotId: number, emdRangeId: number | null, over: Partial<HoldingLot> = {}): HoldingLot => ({
  lotId,
  auctionId: 7,
  emdRangeId,
  released: false,
  rejected: false,
  forfeitureOpen: false,
  ...over,
});

const req = (lotId: number, remarks = "ok") => ({ lotId, remarks });

/** A holding with no consolidated cap and nominal == winning (today's common, single-range shape). */
const holding = (
  emdRangeId: number | null,
  winning: number,
  over: Partial<HoldingWinning> = {},
): HoldingWinning => ({
  auctionId: 7,
  emdRangeId,
  winning,
  nominalAmount: winning,
  consolidatedEmd: null,
  rangeOrder: emdRangeId,
  ...over,
});

describe("planWinningLotRelease", () => {
  it("releases a single-lot range immediately", () => {
    const plan = planWinningLotRelease({
      lots: [lot(301, 1), lot(302, 2), lot(303, 2)],
      winning: [holding(1, 50_000), holding(2, 10_000)],
      requested: [req(301)],
    });
    expect(plan.results).toEqual([{ lotId: 301, error: null }]);
    expect(plan.releases).toEqual([
      { auctionId: 7, emdRangeId: 1, amount: 50_000, lotIds: [301], requestIndexes: [0] },
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("holds the range while another of its lots is pending", () => {
    const plan = planWinningLotRelease({
      lots: [lot(302, 2), lot(303, 2)],
      winning: [holding(2, 10_000)],
      requested: [req(302)],
    });
    expect(plan.results).toEqual([{ lotId: 302, error: null }]);
    expect(plan.releases).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it("releases the range once its last pending lot is released", () => {
    const plan = planWinningLotRelease({
      lots: [lot(302, 2, { released: true }), lot(303, 2)],
      winning: [holding(2, 10_000)],
      requested: [req(303)],
    });
    expect(plan.releases).toEqual([
      { auctionId: 7, emdRangeId: 2, amount: 10_000, lotIds: [302, 303], requestIndexes: [0] },
    ]);
  });

  it("releases the range when all its lots are released in one request", () => {
    const plan = planWinningLotRelease({
      lots: [lot(302, 2), lot(303, 2)],
      winning: [holding(2, 10_000)],
      requested: [req(303), req(302)],
    });
    expect(plan.releases).toEqual([
      expect.objectContaining({ emdRangeId: 2, amount: 10_000, requestIndexes: [0, 1] }),
    ]);
  });

  it("does not count rejected lots as pending", () => {
    const plan = planWinningLotRelease({
      lots: [lot(302, 2, { rejected: true }), lot(303, 2)],
      winning: [holding(2, 10_000)],
      requested: [req(303)],
    });
    expect(plan.releases).toEqual([expect.objectContaining({ emdRangeId: 2, lotIds: [302, 303] })]);
  });

  it("reports unknown, rejected, released, forfeited and duplicate lots by position, without failing the rest", () => {
    const plan = planWinningLotRelease({
      lots: [
        lot(302, 2, { released: true }),
        lot(303, 2, { rejected: true }),
        lot(304, 1, { forfeitureOpen: true }),
        lot(305, 1),
      ],
      // range 2's own lots are both already resolved (one released, one rejected) but its
      // winning was intentionally left out of `winning` (as if already fully credited), so
      // it can't incidentally auto-release here — this test is about row-level error
      // reporting, not range-release behavior.
      winning: [holding(1, 50_000)],
      requested: [req(999), req(302), req(303), req(304), req(305), req(305)],
    });
    expect(plan.results).toEqual([
      { lotId: 999, error: EmdErrorMessages.RELEASE_LOT_NOT_PENDING },
      { lotId: 302, error: EmdErrorMessages.RELEASE_LOT_ALREADY_RELEASED },
      { lotId: 303, error: EmdErrorMessages.RELEASE_LOT_NOT_PENDING },
      { lotId: 304, error: EmdErrorMessages.RELEASE_LOT_FORFEITURE_OPEN },
      { lotId: 305, error: null },
      { lotId: 305, error: EmdErrorMessages.RELEASE_LOT_DUPLICATE },
    ]);
    // The one accepted row (305) is still pending on its own in a two-lot range.
    expect(plan.releases).toEqual([]);
  });

  it("keeps migrated holdings without a range as one unit", () => {
    const plan = planWinningLotRelease({
      lots: [lot(401, null), lot(402, null)],
      winning: [holding(null, 20_000)],
      requested: [req(401), req(402)],
    });
    expect(plan.releases).toEqual([
      expect.objectContaining({ emdRangeId: null, amount: 20_000, lotIds: [401, 402] }),
    ]);
  });

  it("fails only the row with a missing or too-long remark", () => {
    const plan = planWinningLotRelease({
      lots: [lot(301, 1)],
      winning: [holding(1, 50_000)],
      requested: [req(301, "  ")],
    });
    expect(plan.results).toEqual([{ lotId: 301, error: EmdValidationMessages.REMARKS_REQUIRED }]);
    expect(plan.releases).toEqual([]);
  });

  it("rejects a remark over 500 characters", () => {
    const plan = planWinningLotRelease({
      lots: [lot(301, 1)],
      winning: [holding(1, 50_000)],
      requested: [req(301, "x".repeat(501))],
    });
    expect(plan.results).toEqual([{ lotId: 301, error: EmdValidationMessages.REMARKS_MAX }]);
  });

  it("accepts valid rows and skips only the invalid ones, in a mixed request", () => {
    const plan = planWinningLotRelease({
      lots: [lot(301, 1), lot(302, 2), lot(303, 2)],
      winning: [holding(1, 50_000), holding(2, 10_000)],
      requested: [req(301, "lifted"), req(302, ""), req(303, "lifted")],
    });
    expect(plan.results).toEqual([
      { lotId: 301, error: null },
      { lotId: 302, error: EmdValidationMessages.REMARKS_REQUIRED },
      { lotId: 303, error: null },
    ]);
    // 301's single-lot range releases; 302's range stays held because 302 failed.
    expect(plan.releases).toEqual([
      expect.objectContaining({ emdRangeId: 1, lotIds: [301] }),
    ]);
  });

  describe("consolidated EMD cap across sibling ranges", () => {
    // Mirrors auction #11080: consolidated cap ₹4,000, three EMD ranges with nominal
    // ₹1,000/₹2,000/₹3,000 (sum ₹6,000 > cap). Range 1-2 has two won lots (11, 12);
    // ranges 3-4 and 5-6 each have one won lot (14, 15) — the other lot in each of
    // those ranges wasn't won by this bidder. Truncated at close to amount_held
    // 1,000/2,000/1,000 (the third range absorbs the shortfall).
    const CAP = 4_000;
    const r1 = (over: Partial<HoldingWinning> = {}) =>
      holding(101, 1_000, { nominalAmount: 1_000, consolidatedEmd: CAP, ...over });
    const r2 = (over: Partial<HoldingWinning> = {}) =>
      holding(102, 2_000, { nominalAmount: 2_000, consolidatedEmd: CAP, ...over });
    const r3 = (over: Partial<HoldingWinning> = {}) =>
      holding(103, 1_000, { nominalAmount: 3_000, consolidatedEmd: CAP, ...over });

    it("defers a range's release while sibling ranges still consume the consolidated cap", () => {
      // Lot 1 (range 101) was already requested earlier but lot 2 is still untouched,
      // so range 101 stays within-range pending. Lot 5 (range 103) hasn't been
      // requested at all yet. Only lot 4 (range 102) is requested here.
      const plan = planWinningLotRelease({
        lots: [
          lot(11, 101, { released: true }),
          lot(12, 101),
          lot(14, 102),
          lot(15, 103),
        ],
        winning: [r1(), r2(), r3()],
        requested: [req(14, "release lot 4-2000")],
      });
      expect(plan.results).toEqual([{ lotId: 14, error: null }]);
      // min(4000, 1000+3000) = 4000 == total currently blocked (1000+2000+1000) -> nothing releasable.
      expect(plan.releases).toEqual([]);
      expect(plan.deferred).toEqual([{ auctionId: 7, emdRangeId: 102 }]);
    });

    it("releases every decided sibling once the pool covers them, in ascending range order", () => {
      // Lot 4 (range 102) was decided by the previous call but deferred, not touched here.
      // Lot 5 (range 103) is requested now; lot 2 (range 101) is still untouched (range 101
      // stays undecided).
      const plan = planWinningLotRelease({
        lots: [
          lot(11, 101, { released: true }),
          lot(12, 101),
          lot(14, 102, { released: true }),
          lot(15, 103),
        ],
        winning: [r1(), r2(), r3()],
        requested: [req(15, "release lot 5-1000")],
      });
      // Only range 101 is still undecided: required = min(4000, 1000) = 1000. Blocked = 4000.
      // Pool = 3000, shared by the two decided ranges (102, 103) in ascending order: 102 (2000)
      // drains first and releases in full, then 103 (1000) releases in full too.
      expect(plan.releases).toEqual([
        { auctionId: 7, emdRangeId: 102, amount: 2_000, lotIds: [14], requestIndexes: [] },
        { auctionId: 7, emdRangeId: 103, amount: 1_000, lotIds: [15], requestIndexes: [0] },
      ]);
      expect(plan.deferred).toEqual([]);
      // range 101 is still within-range pending (lot 2 untouched) — never "decided", so it
      // never competes for the pool at all.
    });

    it("auto-releases a range deferred by an earlier call once a later call frees up headroom", () => {
      // Range 103 has already been fully credited (its earlier release posted to the DB), so
      // it has dropped out of `winning` entirely. Lot 2 (range 101) is requested now, which
      // also completes range 101; range 102 (decided earlier, still deferred) is re-evaluated
      // here too even though this request doesn't touch its lot.
      const plan = planWinningLotRelease({
        lots: [
          lot(11, 101, { released: true }),
          lot(12, 101),
          lot(14, 102, { released: true }),
        ],
        winning: [r1(), r2()],
        requested: [req(12, "release lot 2-1000")],
      });
      // No range is undecided anymore (103 already dropped out, 101 and 102 both just
      // completed), so required = min(4000, 0) = 0; the whole 3000 blocked is one pool,
      // handed out in ascending range order: 101 (1000) first, then 102 (2000).
      expect(plan.releases).toEqual(
        expect.arrayContaining([
          { auctionId: 7, emdRangeId: 101, amount: 1_000, lotIds: [11, 12], requestIndexes: [0] },
          { auctionId: 7, emdRangeId: 102, amount: 2_000, lotIds: [14], requestIndexes: [] },
        ]),
      );
      expect(plan.releases).toHaveLength(2);
      expect(plan.deferred).toEqual([]);
    });

    it("releases a range's full held amount once decided, when no sibling consumes the cap", () => {
      const plan = planWinningLotRelease({
        lots: [lot(11, 101)],
        winning: [holding(101, 1_000, { nominalAmount: 1_000, consolidatedEmd: null })],
        requested: [req(11, "release lot 1-1000")],
      });
      expect(plan.releases).toEqual([
        { auctionId: 7, emdRangeId: 101, amount: 1_000, lotIds: [11], requestIndexes: [0] },
      ]);
    });

    it("matches auction #372's live three-call sequence (lot 4, then lot 1, then lot 2)", () => {
      // Same shape as #11080: cap 4000, ranges 1-2/3-4/5-6 nominal 1000/2000/3000,
      // held (post-close) 1000/2000/1000. Bidder won lots 1, 2 (range 201), 4 (range
      // 202) and 5 (range 203); each request below is its own call, mirroring the
      // three separate admin actions actually recorded in the DB.
      const w = [
        holding(201, 1_000, { nominalAmount: 1_000, consolidatedEmd: CAP, rangeOrder: 1 }),
        holding(202, 2_000, { nominalAmount: 2_000, consolidatedEmd: CAP, rangeOrder: 2 }),
        holding(203, 1_000, { nominalAmount: 3_000, consolidatedEmd: CAP, rangeOrder: 3 }),
      ];

      const call1 = planWinningLotRelease({
        lots: [lot(1, 201), lot(2, 201), lot(4, 202), lot(5, 203)],
        winning: w,
        requested: [req(4, "release 2000")],
      });
      expect(call1.releases).toEqual([]);
      expect(call1.deferred).toEqual([{ auctionId: 7, emdRangeId: 202 }]);

      const call2 = planWinningLotRelease({
        lots: [lot(1, 201), lot(2, 201), lot(4, 202, { released: true }), lot(5, 203)],
        winning: w,
        requested: [req(1, "release")],
      });
      expect(call2.releases).toEqual([]);
      expect(call2.deferred).toEqual([{ auctionId: 7, emdRangeId: 202 }]);

      const call3 = planWinningLotRelease({
        lots: [
          lot(1, 201, { released: true }),
          lot(2, 201),
          lot(4, 202, { released: true }),
          lot(5, 203),
        ],
        winning: w,
        requested: [req(2, "1000")],
      });
      // Only range 203 (lot 5) is still undecided: required = min(4000, 3000) = 3000.
      // Blocked = 4000, pool = 1000 -> range 201 (order 1) drains it in full; range 202
      // (order 2) gets nothing left and stays deferred.
      expect(call3.releases).toEqual([
        { auctionId: 7, emdRangeId: 201, amount: 1_000, lotIds: [1, 2], requestIndexes: [0] },
      ]);
      expect(call3.deferred).toEqual([{ auctionId: 7, emdRangeId: 202 }]);
    });

    it("drains the pool across 3+ decided ranges in ascending range order, deferring the remainder", () => {
      const plan = planWinningLotRelease({
        lots: [
          lot(21, 301, { released: true }),
          lot(22, 302, { released: true }),
          lot(23, 303, { released: true }),
          lot(24, 304),
        ],
        winning: [
          holding(301, 800, { nominalAmount: 800, consolidatedEmd: 2_000, rangeOrder: 1 }),
          holding(302, 800, { nominalAmount: 800, consolidatedEmd: 2_000, rangeOrder: 2 }),
          holding(303, 800, { nominalAmount: 800, consolidatedEmd: 2_000, rangeOrder: 3 }),
          holding(304, 900, { nominalAmount: 1_500, consolidatedEmd: 2_000, rangeOrder: 4 }),
        ],
        requested: [],
      });
      // range 304 is undecided: required = min(2000, 1500) = 1500. Blocked = 3300.
      // Pool = 1800, drained in ascending order: 301 (800) and 302 (800) release in
      // full, leaving only 200 for 303 — a partial release, so 303 stays deferred too.
      expect(plan.releases).toEqual([
        { auctionId: 7, emdRangeId: 301, amount: 800, lotIds: [21], requestIndexes: [] },
        { auctionId: 7, emdRangeId: 302, amount: 800, lotIds: [22], requestIndexes: [] },
        { auctionId: 7, emdRangeId: 303, amount: 200, lotIds: [23], requestIndexes: [] },
      ]);
      expect(plan.deferred).toEqual([{ auctionId: 7, emdRangeId: 303 }]);
    });
  });
});

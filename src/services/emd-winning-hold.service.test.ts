import { beforeEach, describe, expect, it, vi } from "vitest";

const { lockBiddersMock, availableBalanceMock, postManyMock } = vi.hoisted(() => ({
  lockBiddersMock: vi.fn(),
  availableBalanceMock: vi.fn(),
  postManyMock: vi.fn(),
}));

vi.mock("./emd-transactions.service.js", () => ({
  emdTransactionsService: {
    lockBidders: (...args: unknown[]) => lockBiddersMock(...args),
    availableBalance: (...args: unknown[]) => availableBalanceMock(...args),
    postMany: (...args: unknown[]) => postManyMock(...args),
  },
}));

vi.mock("../db/index.js", () => ({ db: {} }));

const { reconcileWinningHoldForCorrection } = await import("./emd-winning-hold.service.js");

const AUCTION_ID = 7;
const BIDDER_ID = 42;
const USER_ID = 1;

function flattenSqlText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value !== "object") return "";
  const obj = value as { queryChunks?: unknown[]; value?: unknown[] };
  if (Array.isArray(obj.queryChunks)) return obj.queryChunks.map(flattenSqlText).join("");
  if (Array.isArray(obj.value)) return obj.value.map(flattenSqlText).join("");
  return "";
}

type RangeRow = {
  id: number;
  display_order: number | null;
  emd_amount: string;
  lot_display_order_from: string;
  lot_display_order_to: string;
};

type WonLotRow = { id: number; display_order: string | null };

type HeldHold = {
  emdRangeId: number | null;
  amountHeld: string;
  amountReleased: string;
  amountForfeited: string;
  lotIds: number[];
};

/** A thenable that also answers the chain calls `computeWinningHoldTarget` / `currentWinningHoldTotal` make. */
function chain<T>(rows: T[]) {
  const promise: Promise<T[]> & Record<string, (...args: unknown[]) => unknown> =
    Promise.resolve(rows) as never;
  promise.from = () => promise;
  promise.where = () => promise;
  promise.orderBy = () => promise;
  promise.limit = () => promise;
  return promise;
}

/**
 * Stands in for a Drizzle tx: `execute` serves the raw-SQL range/won-lot reads
 * (discriminated by query text), `select` serves the consolidated-EMD lookup
 * and the `emd_range_holds` read, and `insert`/`update` capture hold writes.
 */
function makeTx(input: {
  ranges: RangeRow[];
  wonLots: WonLotRow[];
  consolidatedEmd: string | null;
  holds: HeldHold[];
}) {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const tx = {
    execute: (query: unknown) => {
      const text = flattenSqlText(query).toLowerCase();
      if (text.includes("auction_lot_emd_ranges")) {
        return Promise.resolve({ rows: input.ranges });
      }
      if (text.includes("auction_lot_bidder_maps")) {
        return Promise.resolve({ rows: input.wonLots });
      }
      throw new Error(`Unexpected tx.execute call: ${text}`);
    },
    select: (cols?: Record<string, unknown>) => {
      if (cols && "consolidatedEmdAmount" in cols) {
        return chain([{ consolidatedEmdAmount: input.consolidatedEmd }]);
      }
      return chain(input.holds);
    },
    insert: () => ({
      values: (row: unknown) => {
        inserted.push(row);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (row: unknown) => {
        updated.push(row);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return { tx: tx as never, inserted, updated };
}

function range(id: number, displayOrder: number, emdAmount: number, from: number, to: number): RangeRow {
  return {
    id,
    display_order: displayOrder,
    emd_amount: emdAmount.toFixed(2),
    lot_display_order_from: String(from),
    lot_display_order_to: String(to),
  };
}

describe("reconcileWinningHoldForCorrection", () => {
  beforeEach(() => {
    lockBiddersMock.mockReset().mockResolvedValue(undefined);
    availableBalanceMock.mockReset().mockResolvedValue(0);
    postManyMock.mockReset().mockResolvedValue([1]);
  });

  it("requires nothing and posts nothing when the bidder won no lots, even with holds left over", async () => {
    const { tx } = makeTx({
      ranges: [range(1, 1, 1000, 1, 5)],
      wonLots: [],
      consolidatedEmd: null,
      holds: [
        { emdRangeId: 1, amountHeld: "1000.00", amountReleased: "0.00", amountForfeited: "0.00", lotIds: [11] },
      ],
    });

    await reconcileWinningHoldForCorrection(tx, { auctionId: AUCTION_ID, bidderId: BIDDER_ID, userId: USER_ID });

    expect(availableBalanceMock).not.toHaveBeenCalled();
    expect(postManyMock).toHaveBeenCalledTimes(1);
    expect(postManyMock.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ emdType: "release_winning_correction", amount: 1000 }),
    ]);
  });

  it("throws without posting when the new winner's available balance is insufficient", async () => {
    const { tx } = makeTx({
      ranges: [range(1, 1, 1000, 1, 5)],
      wonLots: [{ id: 11, display_order: "2" }],
      consolidatedEmd: null,
      holds: [],
    });
    availableBalanceMock.mockResolvedValue(500);

    await expect(
      reconcileWinningHoldForCorrection(tx, { auctionId: AUCTION_ID, bidderId: BIDDER_ID, userId: USER_ID }),
    ).rejects.toThrow();
    expect(postManyMock).not.toHaveBeenCalled();
  });

  it("blocks the shortfall from the wallet when the balance covers it", async () => {
    const { tx } = makeTx({
      ranges: [range(1, 1, 1000, 1, 5)],
      wonLots: [{ id: 11, display_order: "2" }],
      consolidatedEmd: null,
      holds: [],
    });
    availableBalanceMock.mockResolvedValue(5000);

    await reconcileWinningHoldForCorrection(tx, { auctionId: AUCTION_ID, bidderId: BIDDER_ID, userId: USER_ID });

    expect(postManyMock.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ emdType: "blocked_winning_correction", amount: 1000 }),
    ]);
  });

  it("needs no new money, and only updates the hold's lots, when the won range is already fully held", async () => {
    const { tx } = makeTx({
      ranges: [range(1, 1, 1000, 1, 5)],
      wonLots: [
        { id: 11, display_order: "2" },
        { id: 12, display_order: "3" },
      ],
      consolidatedEmd: null,
      holds: [
        { emdRangeId: 1, amountHeld: "1000.00", amountReleased: "0.00", amountForfeited: "0.00", lotIds: [11] },
      ],
    });

    await reconcileWinningHoldForCorrection(tx, { auctionId: AUCTION_ID, bidderId: BIDDER_ID, userId: USER_ID });

    expect(availableBalanceMock).not.toHaveBeenCalled();
    expect(postManyMock).not.toHaveBeenCalled();
  });

  it("throws when a won lot's display order is not covered by any configured EMD range", async () => {
    const { tx } = makeTx({
      ranges: [range(1, 1, 1000, 1, 5)],
      wonLots: [{ id: 11, display_order: "99" }],
      consolidatedEmd: null,
      holds: [],
    });

    await expect(
      reconcileWinningHoldForCorrection(tx, { auctionId: AUCTION_ID, bidderId: BIDDER_ID, userId: USER_ID }),
    ).rejects.toThrow();
    expect(availableBalanceMock).not.toHaveBeenCalled();
    expect(postManyMock).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

const {
  blockedBidderIdsForClient,
  currentlyBlockedBidderIdsForClient,
} = await import("./blocked-for-client.js");

/** First select builds the ranked subquery via `.as()`. */
function mockRankedSubquery() {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.as = vi.fn(() => ({ __ranked: true }));
  selectMock.mockReturnValueOnce(chain);
  return chain;
}

/** Second select resolves currently-blocked bidder ids. */
function mockBlockedRows(rows: Array<{ bidderId: number }>) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(async () => rows);
  selectMock.mockReturnValueOnce(chain);
  return chain;
}

describe("blockedBidderIdsForClient", () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it("returns an empty set without querying when bidderIds is empty", async () => {
    const result = await blockedBidderIdsForClient(10, []);
    expect(result).toEqual(new Set());
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns bidder ids whose latest log row is blocked", async () => {
    mockRankedSubquery();
    mockBlockedRows([{ bidderId: 1 }, { bidderId: 3 }]);

    const result = await blockedBidderIdsForClient(10, [1, 2, 3]);
    expect(result).toEqual(new Set([1, 3]));
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes bidder ids before querying", async () => {
    mockRankedSubquery();
    mockBlockedRows([{ bidderId: 5 }]);

    const result = await blockedBidderIdsForClient(10, [5, 5, 5]);
    expect(result).toEqual(new Set([5]));
  });

  it("returns empty set when no latest rows are blocked (e.g. after unblock)", async () => {
    mockRankedSubquery();
    mockBlockedRows([]);

    const result = await blockedBidderIdsForClient(10, [1, 2]);
    expect(result).toEqual(new Set());
  });
});

describe("currentlyBlockedBidderIdsForClient", () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it("returns bidder ids currently blocked for the client", async () => {
    mockRankedSubquery();
    mockBlockedRows([{ bidderId: 7 }, { bidderId: 9 }]);

    const result = await currentlyBlockedBidderIdsForClient(10);
    expect(result).toEqual([7, 9]);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no bidders are blocked", async () => {
    mockRankedSubquery();
    mockBlockedRows([]);

    const result = await currentlyBlockedBidderIdsForClient(10);
    expect(result).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  selectMock,
  currentlyBlockedMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  currentlyBlockedMock: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

vi.mock("../lib/bidders/blocked-for-client.js", () => ({
  currentlyBlockedBidderIdsForClient: (...args: unknown[]) =>
    currentlyBlockedMock(...args),
  blockedBidderIdsForClient: vi.fn(),
}));

const { biddersService } = await import("./bidders.service.js");

function mockSelectChain(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  chain.then = undefined;
  // Allow awaiting the chain directly (no .limit) for unbounded search.
  Object.defineProperty(chain, "then", {
    value: (
      onFulfilled: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    configurable: true,
  });
  selectMock.mockReturnValueOnce(chain);
  return chain;
}

describe("biddersService.listActiveBidderOptions", () => {
  beforeEach(() => {
    selectMock.mockReset();
    currentlyBlockedMock.mockReset();
  });

  it("loads blocked ids when clientId is provided", async () => {
    currentlyBlockedMock.mockResolvedValue([99]);
    // byIds path skipped (no ids); search path
    mockSelectChain([{ id: 1, companyName: "Alpha" }]);

    const result = await biddersService.listActiveBidderOptions({
      clientId: 5,
      q: "1",
    });

    expect(currentlyBlockedMock).toHaveBeenCalledWith(5);
    expect(result).toEqual([{ bidderId: 1, companyName: "Alpha" }]);
  });

  it("skips blocked lookup when clientId is omitted", async () => {
    mockSelectChain([{ id: 2, companyName: "Beta" }]);

    const result = await biddersService.listActiveBidderOptions({ q: "Beta" });

    expect(currentlyBlockedMock).not.toHaveBeenCalled();
    expect(result).toEqual([{ bidderId: 2, companyName: "Beta" }]);
  });
});

describe("biddersService.listActiveBidderOptionIds", () => {
  beforeEach(() => {
    selectMock.mockReset();
    currentlyBlockedMock.mockReset();
  });

  it("loads blocked ids when clientId is provided", async () => {
    currentlyBlockedMock.mockResolvedValue([]);
    // count query
    mockSelectChain([{ total: 1 }]);
    // ids query
    mockSelectChain([{ id: 3 }]);

    const result = await biddersService.listActiveBidderOptionIds({
      clientId: 8,
      q: "3",
    });

    expect(currentlyBlockedMock).toHaveBeenCalledWith(8);
    expect(result.ids).toEqual([3]);
    expect(result.total).toBe(1);
  });
});

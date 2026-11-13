import { beforeEach, describe, expect, it, vi } from "vitest";

const { blockedBidderIdsForClientMock, selectMock } = vi.hoisted(() => ({
  blockedBidderIdsForClientMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("../lib/bidders/blocked-for-client.js", () => ({
  blockedBidderIdsForClient: (...args: unknown[]) =>
    blockedBidderIdsForClientMock(...args),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

function chainResult(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

const { pgCorrectionWinnerCandidates } = await import(
  "./auctions-pg.service.js"
);

describe("pgCorrectionWinnerCandidates", () => {
  beforeEach(() => {
    blockedBidderIdsForClientMock.mockReset();
    selectMock.mockReset();
  });

  it("returns empty when the client has no mapped bidders", async () => {
    selectMock.mockReturnValueOnce(chainResult([{ bidders: [] }]));
    await expect(pgCorrectionWinnerCandidates(1, 10, 100)).resolves.toEqual(
      [],
    );
    expect(blockedBidderIdsForClientMock).not.toHaveBeenCalled();
  });

  it("flags mappedToLot and excludes blocked / inactive bidders", async () => {
    selectMock
      .mockReturnValueOnce(chainResult([{ bidders: [1, 2, 3, 4] }]))
      .mockReturnValueOnce(
        chainResult([
          { bidderId: 1, bidderName: "Alpha", isActive: true },
          { bidderId: 2, bidderName: "Beta", isActive: true },
          { bidderId: 4, bidderName: "Delta", isActive: true },
        ]),
      )
      .mockReturnValueOnce(chainResult([{ bidderId: 2 }, { bidderId: 4 }]));

    blockedBidderIdsForClientMock.mockResolvedValue(new Set([3]));

    const result = await pgCorrectionWinnerCandidates(7, 10, 100);

    expect(blockedBidderIdsForClientMock).toHaveBeenCalledWith(7, [1, 2, 3, 4]);
    expect(result).toEqual([
      { bidderCompId: 1, bidderName: "Alpha", mappedToLot: false },
      { bidderCompId: 2, bidderName: "Beta", mappedToLot: true },
      { bidderCompId: 4, bidderName: "Delta", mappedToLot: true },
    ]);
  });
});

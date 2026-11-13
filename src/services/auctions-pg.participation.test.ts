import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  unionClientMaterialsMock,
  unionClientBiddersMock,
  unionBidderMaterialsMock,
  selectMock,
} = vi.hoisted(() => ({
  unionClientMaterialsMock: vi.fn(),
  unionClientBiddersMock: vi.fn(),
  unionBidderMaterialsMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("../lib/array-set.js", () => ({
  unionClientMaterials: (...args: unknown[]) =>
    unionClientMaterialsMock(...args),
  unionClientBidders: (...args: unknown[]) => unionClientBiddersMock(...args),
  unionBidderMaterials: (...args: unknown[]) =>
    unionBidderMaterialsMock(...args),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

function chainResult(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  // Make thenable for await db.select()...where()
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

const {
  pgUnionClientMaterialsFromItemIds,
  pgRecordBidderClientParticipation,
} = await import("./auctions-pg.service.js");

describe("pgUnionClientMaterialsFromItemIds", () => {
  beforeEach(() => {
    unionClientMaterialsMock.mockReset().mockResolvedValue(true);
    selectMock.mockReset();
  });

  it("unions material ids resolved from items", async () => {
    selectMock.mockReturnValue(
      chainResult([{ materialId: 11 }, { materialId: 11 }, { materialId: 22 }]),
    );
    const executor = { execute: vi.fn() };
    await pgUnionClientMaterialsFromItemIds(executor, 5, [100, 101], 9);
    expect(unionClientMaterialsMock).toHaveBeenCalledWith(
      executor,
      5,
      [11, 22],
      9,
    );
  });

  it("skips union when items have no materials", async () => {
    selectMock.mockReturnValue(chainResult([{ materialId: null }]));
    await pgUnionClientMaterialsFromItemIds({ execute: vi.fn() }, 5, [100], 9);
    expect(unionClientMaterialsMock).not.toHaveBeenCalled();
  });
});

describe("pgRecordBidderClientParticipation", () => {
  beforeEach(() => {
    unionClientBiddersMock.mockReset().mockResolvedValue(true);
    unionBidderMaterialsMock.mockReset().mockResolvedValue(true);
    selectMock.mockReset();
  });

  it("unions bidder into clients.bidders and materials onto bidder", async () => {
    selectMock.mockReturnValue(
      chainResult([{ materialId: 3 }, { materialId: 7 }]),
    );
    const executor = { execute: vi.fn() };
    await pgRecordBidderClientParticipation(executor, 10, [50, 50], [1, 2], 8);

    expect(unionClientBiddersMock).toHaveBeenCalledWith(executor, 10, [50], 8);
    expect(unionBidderMaterialsMock).toHaveBeenCalledWith(
      executor,
      50,
      [3, 7],
      8,
    );
  });

  it("still maps client↔bidder when lots have no materials", async () => {
    selectMock.mockReturnValue(chainResult([]));
    const executor = { execute: vi.fn() };
    await pgRecordBidderClientParticipation(executor, 10, [50], [1], 8);
    expect(unionClientBiddersMock).toHaveBeenCalled();
    expect(unionBidderMaterialsMock).not.toHaveBeenCalled();
  });

  it("no-ops when bidder ids empty", async () => {
    await pgRecordBidderClientParticipation({ execute: vi.fn() }, 10, [], [1], 8);
    expect(unionClientBiddersMock).not.toHaveBeenCalled();
  });
});

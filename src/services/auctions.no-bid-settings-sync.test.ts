import { beforeEach, describe, expect, it, vi } from "vitest";

const { pgLotTimesMock, selectQueue, updateCalls } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updateCalls: Array<{ set: Record<string, unknown> }> = [];

  return {
    pgLotTimesMock: vi.fn(),
    selectQueue,
    updateCalls,
  };
});

vi.mock("./auctions-pg.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./auctions-pg.service.js")>();
  return {
    ...actual,
    pgLotTimes: (...args: unknown[]) => pgLotTimesMock(...args),
  };
});

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      const resolve = async () => selectQueue.shift() ?? [];
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => resolve());
      chain.then = (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => resolve().then(onFulfilled, onRejected);
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ set: values });
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
  },
}));

const { auctionsService } = await import("./auctions.service.js");

describe("auctionsService.update no-bid lot sync", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateCalls.length = 0;
    pgLotTimesMock.mockReset();
    pgLotTimesMock.mockResolvedValue([]);
  });

  it("re-arms lot is_no_bid_extension when settings enable no-bid after lots existed", async () => {
    selectQueue.push(
      [
        {
          status: "draft",
          auctionDate: "2026-09-07T00:00:00.000Z",
          clientId: 7,
        },
      ],
      [
        {
          isNoBidExtension: true,
          noBidExtensionInterval: 60,
          noBidExtensionCountMax: 3,
        },
      ],
    );

    await auctionsService.update(
      42,
      {
        isNoBidExtension: true,
        noBidExtensionInterval: 60,
        noBidExtensionCountMax: 3,
      },
      9,
    );

    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.set).toEqual(
      expect.objectContaining({
        isNoBidExtension: true,
        noBidExtensionInterval: 60,
        noBidExtensionCountMax: 3,
      }),
    );
    expect(updateCalls[1]?.set).toEqual(
      expect.objectContaining({
        isNoBidExtension: true,
        noBidExtensionStoppedAt: null,
        noBidExtensionStoppedBy: null,
        updatedBy: 9,
      }),
    );
  });

  it("clears lot is_no_bid_extension when settings disable no-bid", async () => {
    selectQueue.push(
      [
        {
          status: "draft",
          auctionDate: "2026-09-07T00:00:00.000Z",
          clientId: 7,
        },
      ],
      [
        {
          isNoBidExtension: false,
          noBidExtensionInterval: 0,
          noBidExtensionCountMax: 0,
        },
      ],
    );

    await auctionsService.update(
      42,
      {
        isNoBidExtension: false,
        noBidExtensionInterval: 0,
        noBidExtensionCountMax: 0,
      },
      1,
    );

    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[1]?.set).toEqual(
      expect.objectContaining({
        isNoBidExtension: false,
        updatedBy: 1,
      }),
    );
    expect(updateCalls[1]?.set).not.toHaveProperty("noBidExtensionStoppedAt");
  });

  it("does not sync lots when no-bid fields are not in the patch", async () => {
    selectQueue.push([
      {
        status: "draft",
        auctionDate: "2026-09-07T00:00:00.000Z",
        clientId: 7,
      },
    ]);

    await auctionsService.update(42, { isRankBased: true }, 1);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.set).toEqual(
      expect.objectContaining({ isRankBased: true }),
    );
  });
});

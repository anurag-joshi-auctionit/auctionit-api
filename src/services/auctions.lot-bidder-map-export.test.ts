import { beforeEach, describe, expect, it, vi } from "vitest";

const { pgLotBidderMapForExportMock, pgEmdRangesMock } = vi.hoisted(() => ({
  pgLotBidderMapForExportMock: vi.fn(),
  pgEmdRangesMock: vi.fn(),
}));

vi.mock("./auctions-pg.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./auctions-pg.service.js")>();
  return {
    ...actual,
    pgLotBidderMapForExport: (...args: unknown[]) =>
      pgLotBidderMapForExportMock(...args),
    pgEmdRanges: (...args: unknown[]) => pgEmdRangesMock(...args),
  };
});

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(async () => [{ id: 42 }]);
      return chain;
    }),
  },
}));

const { auctionsService } = await import("./auctions.service.js");

const AUCTION_ID = 42;

describe("AuctionsService.lotBidderMapExportRows", () => {
  beforeEach(() => {
    pgLotBidderMapForExportMock.mockReset();
    pgEmdRangesMock.mockReset();
  });

  it("groups a bidder's lots by isEmdWithClient into separate rows", async () => {
    pgLotBidderMapForExportMock.mockResolvedValue([
      { bidderId: 1, bidderName: "Acme", displayOrder: 1, isEmdWithClient: false },
      { bidderId: 1, bidderName: "Acme", displayOrder: 2, isEmdWithClient: false },
      { bidderId: 1, bidderName: "Acme", displayOrder: 5, isEmdWithClient: true },
    ]);
    pgEmdRangesMock.mockResolvedValue([
      { lotEmdId: 1, lotDisplayOrderFrom: 1, lotDisplayOrderTo: 2, emd: 500, displayOrder: 1 },
      { lotEmdId: 2, lotDisplayOrderFrom: 3, lotDisplayOrderTo: 6, emd: 800, displayOrder: 2 },
    ]);

    const rows = await auctionsService.lotBidderMapExportRows(AUCTION_ID);

    expect(rows).toHaveLength(2);

    const notWithClient = rows.find((r) => !r.isEmdWithClient)!;
    expect(notWithClient.bidderId).toBe(1);
    expect(notWithClient.lotDisplayOrders).toEqual([1, 2]);
    expect(notWithClient.emdDisplayOrders).toEqual([1]);

    const withClient = rows.find((r) => r.isEmdWithClient)!;
    expect(withClient.lotDisplayOrders).toEqual([5]);
    expect(withClient.emdDisplayOrders).toEqual([2]);
  });

  it("includes a bidder whose EMD was released as a non-winner (still active)", async () => {
    pgLotBidderMapForExportMock.mockResolvedValue([
      { bidderId: 2, bidderName: "Released Bidder", displayOrder: 1, isEmdWithClient: false },
    ]);
    pgEmdRangesMock.mockResolvedValue([
      { lotEmdId: 1, lotDisplayOrderFrom: 1, lotDisplayOrderTo: 1, emd: 500, displayOrder: 1 },
    ]);

    const rows = await auctionsService.lotBidderMapExportRows(AUCTION_ID);

    expect(rows).toEqual([
      {
        bidderId: 2,
        bidderName: "Released Bidder",
        lotDisplayOrders: [1],
        emdDisplayOrders: [1],
        isEmdWithClient: false,
      },
    ]);
  });

  it("returns an empty list when nothing is attached", async () => {
    pgLotBidderMapForExportMock.mockResolvedValue([]);
    pgEmdRangesMock.mockResolvedValue([]);

    const rows = await auctionsService.lotBidderMapExportRows(AUCTION_ID);

    expect(rows).toEqual([]);
  });
});

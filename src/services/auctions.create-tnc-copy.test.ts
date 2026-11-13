import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  pgCopyClientTncToAuctionMock,
  resolveAuctionNumberMock,
} = vi.hoisted(() => ({
  pgCopyClientTncToAuctionMock: vi.fn(),
  resolveAuctionNumberMock: vi.fn(),
}));

vi.mock("./auctions-pg.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./auctions-pg.service.js")>();
  return {
    ...actual,
    pgCopyClientTncToAuction: (...args: unknown[]) =>
      pgCopyClientTncToAuctionMock(...args),
  };
});

const insertValuesMock = vi.fn(async () => undefined);
const selectFromMock = vi.fn(() => ({
  from: vi.fn(async () => [{ id: 10 }]),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectFromMock(...args),
    insert: vi.fn(() => ({
      values: (...args: unknown[]) => insertValuesMock(...args),
    })),
  },
}));

const { auctionsService } = await import("./auctions.service.js");

// Years ahead of whenever the suite runs, so publishedAt/auctionDate stay
// valid against the new server-side publishedAt-window check indefinitely.
const FUTURE_YEAR = new Date().getFullYear() + 5;

const createBody = {
  clientId: 7,
  auctionNumber: null as string | null,
  auctionType: "forward",
  emdAmount: null as number | null,
  auctionDate: `${FUTURE_YEAR}-08-10T10:00:00.000Z`,
  publishedAt: `${FUTURE_YEAR}-08-09T10:00:00.000Z`,
  noBidExtensionInterval: null as number | null,
  noBidExtensionCountMax: null as number | null,
  isNoBidExtension: true,
  isStartBidPricePlusIncrement: false,
  isSealedBid: false,
  ipAddressRestrictionEnabled: false,
  isRankBased: true,
};

describe("auctionsService.create client TnC copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAuctionNumberMock.mockResolvedValue("FWD-7-1");
    vi.spyOn(
      auctionsService as unknown as {
        resolveAuctionNumber: (...args: unknown[]) => Promise<string>;
      },
      "resolveAuctionNumber",
    ).mockImplementation((...args) => resolveAuctionNumberMock(...args));
    // Uniqueness is covered by auctions.auction-number-unique.test.ts.
    vi.spyOn(
      auctionsService as unknown as {
        assertAuctionNumberAvailable: (...args: unknown[]) => Promise<void>;
      },
      "assertAuctionNumberAvailable",
    ).mockResolvedValue(undefined);
    pgCopyClientTncToAuctionMock.mockResolvedValue({
      id: 1,
      documentTypeId: 2,
    });
  });

  it("copies client TnC after inserting the draft auction", async () => {
    const result = await auctionsService.create(createBody, 99);

    expect(result).toEqual({ auctionId: 11 });
    expect(insertValuesMock).toHaveBeenCalled();
    expect(pgCopyClientTncToAuctionMock).toHaveBeenCalledWith({
      clientId: 7,
      auctionId: 11,
      userId: 99,
    });
  });

  it("still creates the auction when TnC copy fails", async () => {
    pgCopyClientTncToAuctionMock.mockRejectedValue(new Error("R2 down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await auctionsService.create(createBody, 99);

    expect(result).toEqual({ auctionId: 11 });
    expect(pgCopyClientTncToAuctionMock).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("still creates the auction when client has no TnC", async () => {
    pgCopyClientTncToAuctionMock.mockResolvedValue(null);

    const result = await auctionsService.create(createBody, 99);

    expect(result).toEqual({ auctionId: 11 });
    expect(pgCopyClientTncToAuctionMock).toHaveBeenCalledWith({
      clientId: 7,
      auctionId: 11,
      userId: 99,
    });
  });
});

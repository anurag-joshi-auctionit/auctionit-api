import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";

const {
  pgGetAuctionClientIdMock,
  pgLotTimesMock,
  pgCopyClientTncToAuctionMock,
  selectQueue,
  insertValuesMock,
  updateSetMock,
} = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const insertValuesMock = vi.fn(async () => undefined);
  const updateSetMock = vi.fn(() => ({
    where: vi.fn(async () => undefined),
  }));

  return {
    pgGetAuctionClientIdMock: vi.fn(),
    pgLotTimesMock: vi.fn(),
    pgCopyClientTncToAuctionMock: vi.fn(),
    selectQueue,
    insertValuesMock,
    updateSetMock,
  };
});

vi.mock("./auctions-pg.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./auctions-pg.service.js")>();
  return {
    ...actual,
    pgGetAuctionClientId: (...args: unknown[]) =>
      pgGetAuctionClientIdMock(...args),
    pgLotTimes: (...args: unknown[]) => pgLotTimesMock(...args),
    pgCopyClientTncToAuction: (...args: unknown[]) =>
      pgCopyClientTncToAuctionMock(...args),
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
    insert: vi.fn(() => ({
      values: insertValuesMock,
    })),
    update: vi.fn(() => ({
      set: updateSetMock,
    })),
  },
}));

const { auctionsService } = await import(
  "./auctions.service.js"
);

// Years ahead of whenever the suite runs, so publishedAt/auctionDate stay
// valid against the server-side publishedAt-window check indefinitely.
const FUTURE_YEAR = new Date().getFullYear() + 5;

const CREATE_BODY = {
  clientId: 7,
  auctionNumber: "2024-01",
  auctionType: "forward",
  emdAmount: null,
  auctionDate: `${FUTURE_YEAR}-09-01T10:00:00.000Z`,
  publishedAt: `${FUTURE_YEAR}-08-20T10:00:00.000Z`,
  noBidExtensionInterval: null,
  noBidExtensionCountMax: null,
  isNoBidExtension: true,
  isStartBidPricePlusIncrement: false,
  isSealedBid: false,
  ipAddressRestrictionEnabled: false,
  isRankBased: false,
};

describe("auction number uniqueness", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    insertValuesMock.mockReset();
    insertValuesMock.mockResolvedValue(undefined);
    updateSetMock.mockReset();
    updateSetMock.mockReturnValue({
      where: vi.fn(async () => undefined),
    });
    pgGetAuctionClientIdMock.mockReset();
    pgLotTimesMock.mockReset();
    pgLotTimesMock.mockResolvedValue([]);
    pgCopyClientTncToAuctionMock.mockReset();
    pgCopyClientTncToAuctionMock.mockResolvedValue(undefined);
  });

  it("creates when the auction number is unique for the client", async () => {
    selectQueue.push(
      [{ id: 10 }], // max id
      [{ auctionPrefix: "JSGL/" }], // resolve prefix
      [], // assert uniqueness — no conflict
    );

    const result = await auctionsService.create(CREATE_BODY, 1);

    expect(result).toEqual({ auctionId: 11 });
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auctionNumber: "JSGL/2024-01",
        clientId: 7,
      }),
    );
  });

  it("rejects create when the same client already has the number", async () => {
    selectQueue.push(
      [{ id: 10 }],
      [{ auctionPrefix: "JSGL/" }],
      [{ id: 3 }], // conflict
    );

    await expect(auctionsService.create(CREATE_BODY, 1)).rejects.toMatchObject({
      name: "AuctionValidationError",
      message: AuctionsValidationMessages.AUCTION_NUMBER_DUPLICATE,
      fieldErrors: {
        auctionNumber: [AuctionsValidationMessages.AUCTION_NUMBER_DUPLICATE],
      },
    });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("allows the same number for a different client", async () => {
    selectQueue.push(
      [{ id: 10 }],
      [{ auctionPrefix: "ACME/" }],
      [], // no conflict for ACME
    );

    await expect(
      auctionsService.create({ ...CREATE_BODY, clientId: 99 }, 1),
    ).resolves.toEqual({ auctionId: 11 });
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 99,
        auctionNumber: "ACME/2024-01",
      }),
    );
  });

  it("allows reuse when only an archived auction holds the number", async () => {
    // assert query filters out archived; empty result means available
    selectQueue.push(
      [{ id: 10 }],
      [{ auctionPrefix: "JSGL/" }],
      [],
    );

    await expect(auctionsService.create(CREATE_BODY, 1)).resolves.toEqual({
      auctionId: 11,
    });
  });

  it("maps insert unique-violation to a field error", async () => {
    selectQueue.push(
      [{ id: 10 }],
      [{ auctionPrefix: "JSGL/" }],
      [],
    );
    const err = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "auctions_client_id_auction_number_active_uidx",
    });
    insertValuesMock.mockRejectedValue(err);

    await expect(auctionsService.create(CREATE_BODY, 1)).rejects.toMatchObject({
      name: "AuctionValidationError",
      message: AuctionsValidationMessages.AUCTION_NUMBER_DUPLICATE,
      fieldErrors: {
        auctionNumber: [AuctionsValidationMessages.AUCTION_NUMBER_DUPLICATE],
      },
    });
  });

  it("rejects patch when changing to a duplicate number", async () => {
    selectQueue.push(
      [
        {
          status: "draft",
          auctionDate: "2026-09-01T10:00:00.000Z",
          clientId: 7,
        },
      ],
      [{ auctionPrefix: "JSGL/" }],
      [{ id: 99 }], // conflict with another auction
    );

    await expect(
      auctionsService.update(42, { auctionNumber: "2024-01" }, 1),
    ).rejects.toMatchObject({
      name: "AuctionValidationError",
      message: AuctionsValidationMessages.AUCTION_NUMBER_DUPLICATE,
    });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("allows patch that keeps the auction's own number", async () => {
    selectQueue.push(
      [
        {
          status: "draft",
          auctionDate: "2026-09-01T10:00:00.000Z",
          clientId: 7,
        },
      ],
      [{ auctionPrefix: "JSGL/" }],
      [], // no other auction conflicts (self excluded)
    );

    await expect(
      auctionsService.update(42, { auctionNumber: "2024-01" }, 1),
    ).resolves.toBeUndefined();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auctionNumber: "JSGL/2024-01",
      }),
    );
  });
});

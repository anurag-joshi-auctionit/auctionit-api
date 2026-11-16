import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { parseLotDateTimeOnAuctionDate } from "@auctionit/lib/lot-schedule";

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
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  },
}));

const { auctionsService } = await import("./auctions.service.js");

/** UTC-midnight encoding of (today + daysAhead) IST calendar day — matches auction_date. */
function futureAuctionDate(daysAhead: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

const auctionDate = futureAuctionDate(10);
const lotStartTime = "16:00:00";
const lotEndTime = "17:00:00";
// The lot's actual start instant (auctionDate + 16:00 IST) — deterministic
// regardless of what time of day the suite happens to run.
const lotStartInstant = parseLotDateTimeOnAuctionDate(lotStartTime, auctionDate)!;
const publishedAtBeforeLotStart = new Date(
  lotStartInstant.getTime() - 60 * 60 * 1000,
).toISOString();
const publishedAtAfterLotStart = new Date(
  lotStartInstant.getTime() + 60 * 60 * 1000,
).toISOString();

describe("auctionsService.update publishedAt vs existing lot starts", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateCalls.length = 0;
    pgLotTimesMock.mockReset();
  });

  it("rejects a publishedAt after an existing active lot's start time", async () => {
    pgLotTimesMock.mockResolvedValue([
      { lotStartTime, lotEndTime },
    ]);
    selectQueue.push([
      {
        status: "draft",
        auctionDate,
        publishedAt: publishedAtBeforeLotStart,
        clientId: 7,
      },
    ]);

    await expect(
      auctionsService.update(
        42,
        { publishedAt: publishedAtAfterLotStart },
        1,
      ),
    ).rejects.toMatchObject({
      name: "AuctionValidationError",
      message:
        AuctionsValidationMessages.PUBLISHED_AT_MUST_BE_ON_OR_BEFORE_EARLIEST_LOT_START,
      fieldErrors: {
        publishedAt: [
          AuctionsValidationMessages.PUBLISHED_AT_MUST_BE_ON_OR_BEFORE_EARLIEST_LOT_START,
        ],
      },
    });
    expect(updateCalls).toHaveLength(0);
  });

  it("accepts a publishedAt on or before every existing active lot's start time", async () => {
    pgLotTimesMock.mockResolvedValue([
      { lotStartTime, lotEndTime },
    ]);
    selectQueue.push([
      {
        status: "draft",
        auctionDate,
        publishedAt: publishedAtBeforeLotStart,
        clientId: 7,
      },
    ]);

    await expect(
      auctionsService.update(
        42,
        { publishedAt: publishedAtBeforeLotStart },
        1,
      ),
    ).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(1);
  });

  it("skips the lot cross-check when the auction has no active lots yet", async () => {
    pgLotTimesMock.mockResolvedValue([]);
    selectQueue.push([
      {
        status: "draft",
        auctionDate,
        publishedAt: publishedAtBeforeLotStart,
        clientId: 7,
      },
    ]);

    await expect(
      auctionsService.update(
        42,
        { publishedAt: publishedAtAfterLotStart },
        1,
      ),
    ).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(1);
  });
});

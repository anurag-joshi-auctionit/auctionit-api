import { describe, expect, it, vi } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";

vi.mock("../db/index.js", () => ({ db: {} }));

const { assertPublishedAtWindow } = await import("./auctions.service.js");

const auctionDate = "2099-01-01T00:00:00.000Z";
const now = new Date("2098-12-01T00:00:00.000Z");

describe("assertPublishedAtWindow", () => {
  it("rejects publishedAt at or before now", () => {
    expect(() =>
      assertPublishedAtWindow(now.toISOString(), auctionDate, { now }),
    ).toThrow(AuctionsValidationMessages.PUBLISHED_AT_MUST_BE_FUTURE);

    const past = new Date(now.getTime() - 1000).toISOString();
    expect(() =>
      assertPublishedAtWindow(past, auctionDate, { now }),
    ).toThrow(AuctionsValidationMessages.PUBLISHED_AT_MUST_BE_FUTURE);
  });

  it("rejects publishedAt after the auction's calendar day", () => {
    // future's IST calendar day (Dec 1) is after this auction date (Nov 20).
    const future = new Date(now.getTime() + 1000).toISOString();
    expect(() =>
      assertPublishedAtWindow(future, "2098-11-20T00:00:00.000Z", { now }),
    ).toThrow(
      AuctionsValidationMessages.PUBLISHED_AT_MUST_BE_ON_OR_BEFORE_AUCTION_DATE,
    );
  });

  it("accepts a publishedAt that is future and on/before the auction date", () => {
    const future = new Date(now.getTime() + 1000).toISOString();
    expect(() =>
      assertPublishedAtWindow(future, auctionDate, { now }),
    ).not.toThrow();
    expect(() =>
      assertPublishedAtWindow(auctionDate, auctionDate, { now }),
    ).not.toThrow();
  });
});

import { describe, expect, it, vi } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";

vi.mock("../db/index.js", () => ({ db: {} }));

const { mergeSealedBidPatch, assertSealedDateOnOrBeforeAuctionDate } =
  await import("./auctions.service.js");

const DAY = "2099-01-01T00:00:00.000Z";
const current = {
  isSealedBid: true,
  sealedBidDate: DAY,
  sealedBidStartTime: "09:00:00",
  sealedBidEndTime: "10:00:00",
};

describe("mergeSealedBidPatch", () => {
  it("treats a resend of the same values as no change", () => {
    expect(
      mergeSealedBidPatch(current, {
        isSealedBid: true,
        // The editor sends HH:mm and an ISO day; the row stores HH:mm:ss.
        sealedBidDate: "2099-01-01T00:00:00.000Z",
        sealedBidStartTime: "09:00",
        sealedBidEndTime: "10:00",
      }),
    ).toEqual({});
  });

  it("does not re-check a lapsed window when nothing changed", () => {
    const lapsed = { ...current, sealedBidDate: "2000-01-01T00:00:00.000Z" };
    expect(
      mergeSealedBidPatch(lapsed, { sealedBidEndTime: "10:00:00" }),
    ).toEqual({});
  });

  it("applies a real change", () => {
    expect(
      mergeSealedBidPatch(current, { sealedBidEndTime: "11:00:00" }),
    ).toMatchObject({ sealedBidEndTime: "11:00:00" });
  });

  it("rejects a real change once the window is locked", () => {
    expect(() =>
      mergeSealedBidPatch(
        current,
        { sealedBidEndTime: "11:00:00" },
        { windowLocked: true },
      ),
    ).toThrow(AuctionsValidationMessages.SEALED_BID_SETTINGS_LOCKED);
  });

  it("still allows an unchanged resend when the window is locked", () => {
    expect(
      mergeSealedBidPatch(
        current,
        { sealedBidEndTime: "10:00" },
        { windowLocked: true },
      ),
    ).toEqual({});
  });

  it("rejects a reschedule whose new start has already passed", () => {
    expect(() =>
      mergeSealedBidPatch(current, {
        sealedBidDate: "2000-01-01T00:00:00.000Z",
        sealedBidStartTime: "09:00:00",
        sealedBidEndTime: "10:00:00",
      }),
    ).toThrow(AuctionsValidationMessages.SEALED_BID_WINDOW_START_MUST_BE_FUTURE);
  });

  it("allows rescheduling the window forward with no windowLocked gate", () => {
    expect(
      mergeSealedBidPatch(current, {
        sealedBidDate: "2099-06-01T00:00:00.000Z",
        sealedBidStartTime: "09:00:00",
        sealedBidEndTime: "10:00:00",
      }),
    ).toMatchObject({ sealedBidDate: "2099-06-01T00:00:00.000Z" });
  });
});

describe("assertSealedDateOnOrBeforeAuctionDate", () => {
  it("rejects when the sealed date is after the auction date", () => {
    expect(() =>
      assertSealedDateOnOrBeforeAuctionDate(
        current,
        "2098-12-31T00:00:00.000Z",
      ),
    ).toThrow(AuctionsValidationMessages.SEALED_BID_DATE_AFTER_AUCTION_DATE);
  });

  it("accepts on or before the auction date", () => {
    expect(() =>
      assertSealedDateOnOrBeforeAuctionDate(current, DAY),
    ).not.toThrow();
    expect(() =>
      assertSealedDateOnOrBeforeAuctionDate(
        current,
        "2099-06-01T00:00:00.000Z",
      ),
    ).not.toThrow();
  });

  it("skips auctions with no sealed window", () => {
    expect(() =>
      assertSealedDateOnOrBeforeAuctionDate(
        { ...current, isSealedBid: false },
        "2098-12-31T00:00:00.000Z",
      ),
    ).not.toThrow();
  });
});

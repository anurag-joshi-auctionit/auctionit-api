import { describe, expect, it } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";

describe("settlement winner correction messages", () => {
  it("exposes WINNER_NOT_CLIENT_MAPPED", () => {
    expect(AuctionsValidationMessages.WINNER_NOT_CLIENT_MAPPED).toMatch(
      /client/i,
    );
  });

  it("keeps Offline negotiated reject reason", () => {
    expect(AuctionsValidationMessages.OFFLINE_NEGOTIATED).toBe(
      "Offline negotiated",
    );
  });
});

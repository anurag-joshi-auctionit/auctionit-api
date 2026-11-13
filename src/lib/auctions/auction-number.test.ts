import { describe, expect, it } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { buildAuctionNumber } from "./auction-number.js";

describe("buildAuctionNumber", () => {
  it("returns null when both prefix and input are empty", () => {
    expect(buildAuctionNumber(null, null)).toBeNull();
    expect(buildAuctionNumber("", "  ")).toBeNull();
  });

  it("returns input unchanged when prefix is empty", () => {
    expect(buildAuctionNumber(null, "ABC-1")).toBe("ABC-1");
    expect(buildAuctionNumber("  ", "ABC-1")).toBe("ABC-1");
  });

  it("prepends prefix to suffix", () => {
    expect(buildAuctionNumber("JSGL/", "2024-01")).toBe("JSGL/2024-01");
  });

  it("is idempotent when input already starts with prefix", () => {
    expect(buildAuctionNumber("JSGL/", "JSGL/2024-01")).toBe("JSGL/2024-01");
  });

  it("strips all whitespace, not just leading/trailing, so near-duplicates normalize to the same value", () => {
    expect(buildAuctionNumber(null, "FA- 24")).toBe("FA-24");
    expect(buildAuctionNumber(null, "FA - 2 4")).toBe("FA-24");
    expect(buildAuctionNumber("JSGL/", "2024- 01")).toBe("JSGL/2024-01");
  });

  it("throws when the concatenated value exceeds 50 chars", () => {
    const prefix = "PREFIX-";
    const suffix = "x".repeat(50);
    expect(() => buildAuctionNumber(prefix, suffix)).toThrow(
      AuctionsValidationMessages.AUCTION_NUMBER_TOO_LONG,
    );
  });
});

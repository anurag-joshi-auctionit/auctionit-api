import { describe, expect, it } from "vitest";
import {
  AUCTION_ABOUT_TO_START_MINUTES,
  auctionEmailDedupeKey,
  bidderAppLoginUrl,
  isWithinAboutToStartWindow,
} from "./auction-notification.service.js";

describe("isWithinAboutToStartWindow", () => {
  const start = new Date("2026-06-30T09:30:00.000Z"); // 15:00 IST

  it("is true at exactly 60 minutes before start", () => {
    const now = new Date(start.getTime() - AUCTION_ABOUT_TO_START_MINUTES * 60 * 1000);
    expect(isWithinAboutToStartWindow(start, now)).toBe(true);
  });

  it("is false more than 60 minutes before start", () => {
    const now = new Date(
      start.getTime() - AUCTION_ABOUT_TO_START_MINUTES * 60 * 1000 - 1,
    );
    expect(isWithinAboutToStartWindow(start, now)).toBe(false);
  });

  it("is true one millisecond before start", () => {
    const now = new Date(start.getTime() - 1);
    expect(isWithinAboutToStartWindow(start, now)).toBe(true);
  });

  it("is false at start (auction is live)", () => {
    expect(isWithinAboutToStartWindow(start, start)).toBe(false);
  });

  it("is false after start", () => {
    expect(
      isWithinAboutToStartWindow(start, new Date(start.getTime() + 1)),
    ).toBe(false);
  });
});

describe("auctionEmailDedupeKey", () => {
  it("is case-insensitive and trims the recipient", () => {
    expect(auctionEmailDedupeKey(12, "  Foo@Example.COM ")).toBe(
      "12:foo@example.com",
    );
  });

  it("treats the same auction + email as already sent (second close no-op)", () => {
    const sent = new Set([auctionEmailDedupeKey(88, "poc@bidder.com")]);
    expect(sent.has(auctionEmailDedupeKey(88, "POC@bidder.com"))).toBe(true);
    expect(sent.has(auctionEmailDedupeKey(89, "poc@bidder.com"))).toBe(false);
  });
});

describe("bidderAppLoginUrl", () => {
  it("strips trailing slashes", () => {
    expect(bidderAppLoginUrl("http://localhost:3002/")).toBe(
      "http://localhost:3002",
    );
    expect(bidderAppLoginUrl("https://auctionit.in///")).toBe(
      "https://auctionit.in",
    );
  });
});

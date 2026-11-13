import { describe, expect, it } from "vitest";
import { shouldReleaseAuctionEmd } from "../lib/bidders/unstarted-emd.js";

describe("shouldReleaseAuctionEmd", () => {
  it("releases only when the bidder has no maps, bids, or active proxy", () => {
    expect(
      shouldReleaseAuctionEmd({
        remainingActiveMaps: 0,
        bidCount: 0,
        activeProxyCount: 0,
      }),
    ).toBe(true);
  });

  it("keeps EMD blocked while a live lot map remains", () => {
    expect(
      shouldReleaseAuctionEmd({
        remainingActiveMaps: 1,
        bidCount: 0,
        activeProxyCount: 0,
      }),
    ).toBe(false);
  });

  it("keeps EMD blocked when they already bid or have a proxy", () => {
    expect(
      shouldReleaseAuctionEmd({
        remainingActiveMaps: 0,
        bidCount: 1,
        activeProxyCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReleaseAuctionEmd({
        remainingActiveMaps: 0,
        bidCount: 0,
        activeProxyCount: 1,
      }),
    ).toBe(false);
  });
});

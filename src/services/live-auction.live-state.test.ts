import { describe, expect, it } from "vitest";
import { computeLiveState } from "./live-auction.service.js";

/**
 * listLive only returns auctions that would compute as "live" (earliest start
 * passed, latest end still ahead). These cases document that gate.
 */
describe("computeLiveState (listLive live-only filter)", () => {
  it("is upcoming when earliest lot has not started", () => {
    expect(computeLiveState(120, 3600)).toBe("upcoming");
  });

  it("is live once earliest lot start has passed (later lots may still be notStarted)", () => {
    expect(computeLiveState(0, 3600)).toBe("live");
    expect(computeLiveState(-60, 7200)).toBe("live");
  });

  it("is live in a gap after one lot ends while a later lot has not started", () => {
    // firstStartSec already past; lastEndSec still ahead (later lot end)
    expect(computeLiveState(-1800, 900)).toBe("live");
  });

  it("is ended when latest lot end has passed", () => {
    expect(computeLiveState(-3600, 0)).toBe("ended");
    expect(computeLiveState(-3600, -10)).toBe("ended");
  });
});

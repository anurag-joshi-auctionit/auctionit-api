import { describe, expect, it } from "vitest";
import { legacySealedBidWindow } from "./seed-sealed-bid-window.js";

describe("legacySealedBidWindow", () => {
  it("splits start + duration into date / start / end", () => {
    expect(legacySealedBidWindow("2025-03-10T10:30:00", 4)).toEqual({
      sealedBidDate: "2025-03-10T00:00:00",
      sealedBidStartTime: "10:30:00",
      sealedBidEndTime: "14:30:00",
      capped: false,
    });
  });

  it("handles fractional hours and milliseconds in the source", () => {
    expect(
      legacySealedBidWindow("2025-03-10T09:00:00.000", "1.5").sealedBidEndTime,
    ).toBe("10:30:00");
  });

  it("caps a window crossing midnight at 23:59:59", () => {
    const w = legacySealedBidWindow("2025-03-10T20:00:00", 6);
    expect(w.sealedBidEndTime).toBe("23:59:59");
    expect(w.capped).toBe(true);
  });

  it("keeps start but no end when duration is missing or non-positive", () => {
    expect(legacySealedBidWindow("2025-03-10T20:00:00", null)).toMatchObject({
      sealedBidStartTime: "20:00:00",
      sealedBidEndTime: null,
    });
    expect(
      legacySealedBidWindow("2025-03-10T20:00:00", 0).sealedBidEndTime,
    ).toBeNull();
  });

  it("returns an empty window without a start", () => {
    expect(legacySealedBidWindow(null, 4)).toEqual({
      sealedBidDate: null,
      sealedBidStartTime: null,
      sealedBidEndTime: null,
      capped: false,
    });
  });
});

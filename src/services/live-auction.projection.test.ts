import { describe, expect, it } from "vitest";
import {
  projectDeltaForAudience,
  projectLotDetailsForBidder,
  projectLotForAudience,
  type LiveLot,
  type LiveLotDelta,
} from "./live-auction.service.js";

function sampleLot(overrides: Partial<LiveLot> = {}): LiveLot {
  return {
    id: 1,
    lotNumber: "Lot 1",
    displayOrder: 1,
    title: "Scrap",
    materialLocation: null,
    quantity: 100,
    uom: "MT",
    startBidPrice: 1000,
    bidIncrement: 100,
    currentBid: 2500,
    winnerBidderId: 42,
    winnerBidderName: "Acme Trading",
    startsAt: null,
    endsAt: null,
    startLeftSec: 0,
    timeLeftSec: 600,
    notStarted: false,
    closed: false,
    lastBidExtensionCount: 0,
    bidCount: 3,
    bidderCount: 2,
    sbpPlusIncrement: false,
    bidLimit: null,
    ...overrides,
  };
}

function sampleDelta(overrides: Partial<LiveLotDelta> = {}): LiveLotDelta {
  return {
    auctionId: 10,
    lotId: 1,
    currentBid: 2500,
    winnerBidderId: 42,
    winnerBidderName: "Acme Trading",
    bidCount: 3,
    bidderCount: 2,
    seq: 7,
    ...overrides,
  };
}

describe("projectLotForAudience", () => {
  it("leaves admin payloads unchanged (winner identity intact)", () => {
    const lot = sampleLot();
    expect(projectLotForAudience(lot, "admin")).toBe(lot);
    expect(projectLotForAudience(lot, "admin", 99)).toEqual(lot);
  });

  it("strips winner identity for bidder audience and sets yourStatus", () => {
    const lot = sampleLot();
    expect(projectLotForAudience(lot, "bidder", 42)).toEqual({
      ...lot,
      winnerBidderId: null,
      winnerBidderName: null,
      yourStatus: "winning",
    });
    // Non-participant must not see Outbid on join snapshots.
    expect(projectLotForAudience(lot, "bidder", 99)).toMatchObject({
      winnerBidderId: null,
      winnerBidderName: null,
      yourStatus: "none",
    });
    expect(projectLotForAudience(lot, "bidder", 99, true)).toMatchObject({
      winnerBidderId: null,
      winnerBidderName: null,
      yourStatus: "outbid",
    });
  });

  it("keeps winner identity for client audience and omits standing", () => {
    const lot = sampleLot();
    const projected = projectLotForAudience(lot, "client", 42, true);
    expect(projected.winnerBidderId).toBe(42);
    expect(projected.winnerBidderName).toBe("Acme Trading");
    expect(projected.yourStatus).toBeUndefined();
  });

  it("sets yourStatus to none when there is no winner; omits it for shared public payloads", () => {
    const open = sampleLot({ winnerBidderId: null, winnerBidderName: null });
    expect(projectLotForAudience(open, "bidder", 42).yourStatus).toBe("none");
    // No viewing bidderId → public room projection must not send yourStatus.
    expect(projectLotForAudience(sampleLot(), "bidder").yourStatus).toBe(
      undefined,
    );
    expect(
      projectLotForAudience(sampleLot(), "bidder", null).yourStatus,
    ).toBe(undefined);
  });
});

describe("projectDeltaForAudience", () => {
  it("leaves admin deltas unchanged", () => {
    const delta = sampleDelta();
    expect(projectDeltaForAudience(delta, "admin", 1)).toBe(delta);
  });

  it("strips winner names/ids for bidder audience and sets yourStatus when personalized", () => {
    const delta = sampleDelta();
    expect(projectDeltaForAudience(delta, "bidder", 42)).toEqual({
      ...delta,
      winnerBidderId: null,
      winnerBidderName: null,
      yourStatus: "winning",
    });
    expect(projectDeltaForAudience(delta, "bidder", 7)).toMatchObject({
      winnerBidderId: null,
      winnerBidderName: null,
      yourStatus: "none",
    });
    expect(projectDeltaForAudience(delta, "bidder", 7, true)).toMatchObject({
      winnerBidderId: null,
      winnerBidderName: null,
      yourStatus: "outbid",
    });
    expect(projectDeltaForAudience(delta, "bidder").yourStatus).toBe(undefined);
  });

  it("keeps winner identity for client audience and omits standing", () => {
    const delta = sampleDelta();
    const projected = projectDeltaForAudience(delta, "client", 42, true);
    expect(projected.winnerBidderId).toBe(42);
    expect(projected.winnerBidderName).toBe("Acme Trading");
    expect(projected.yourStatus).toBeUndefined();
  });
});

describe("sealed-bid phase withholds the lot bounds from bidders", () => {
  const sealed = sampleLot({ bidLimit: 5000, currentBid: 1000, bidCount: 0 });

  it("nulls start price, bid limit and currentBid in the bidder projection", () => {
    for (const bidderId of [undefined, 7]) {
      const projected = projectLotForAudience(
        sealed,
        "bidder",
        bidderId,
        false,
        false,
        true,
      );
      expect(projected.startBidPrice).toBeNull();
      expect(projected.bidLimit).toBeNull();
      expect(projected.currentBid).toBeNull();
    }
  });

  it("keeps the bounds for admin and client audiences", () => {
    for (const audience of ["admin", "client"] as const) {
      const projected = projectLotForAudience(
        sealed,
        audience,
        null,
        false,
        false,
        true,
      );
      expect(projected.startBidPrice).toBe(1000);
      expect(projected.bidLimit).toBe(5000);
      expect(projected.currentBid).toBe(1000);
    }
  });

  it("keeps the start price and bid limit for bidders outside the sealed phase", () => {
    const open = projectLotForAudience(sealed, "bidder", 7);
    expect(open.startBidPrice).toBe(1000);
    expect(open.bidLimit).toBe(5000);
    expect(open.currentBid).toBe(1000);
    // Rank-based masks only the winning amount; the bid input still needs SBP.
    const ranked = projectLotForAudience(sealed, "bidder", 7, false, true);
    expect(ranked.startBidPrice).toBe(1000);
    expect(ranked.bidLimit).toBe(5000);
    expect(ranked.currentBid).toBeNull();
  });

  it("masks currentBid on sealed-phase deltas for bidders only", () => {
    const delta = sampleDelta({ currentBid: 1000, sealedPhase: true });
    expect(projectDeltaForAudience(delta, "bidder").currentBid).toBeNull();
    expect(projectDeltaForAudience(delta, "bidder", 7, true).currentBid).toBeNull();
    expect(projectDeltaForAudience(delta, "client").currentBid).toBe(1000);
    expect(projectDeltaForAudience(delta, "admin").currentBid).toBe(1000);
    expect(
      projectDeltaForAudience({ ...delta, sealedPhase: false }, "bidder")
        .currentBid,
    ).toBe(1000);
  });

  it("nulls lot-details bounds for bidders only during the sealed phase", () => {
    const details = { id: 1, startBidPrice: 1000, bidLimit: 5000, gst: 18 };
    expect(projectLotDetailsForBidder(details, true)).toEqual({
      id: 1,
      startBidPrice: null,
      bidLimit: null,
      gst: 18,
    });
    expect(projectLotDetailsForBidder(details, false)).toBe(details);
  });
});

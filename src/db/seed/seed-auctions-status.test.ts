import { describe, expect, it } from "vitest";
import { resolveAuctionSeedStatus } from "./seed-auctions-status.js";

const base = {
  isDeleted: false,
  isClosed: false,
  isPublished: false,
  activeLotCount: 0,
  updatedAt: "2026-07-01T12:00:00.000Z",
};

const withLots = {
  ...base,
  activeLotCount: 1,
};

describe("resolveAuctionSeedStatus", () => {
  it("maps zero lots + IsDeleted to archived", () => {
    expect(
      resolveAuctionSeedStatus({
        ...base,
        isDeleted: true,
        isPublished: true,
        isClosed: true,
      }).status,
    ).toBe("archived");
  });

  it("maps zero lots + !IsDeleted to draft (even if published/closed)", () => {
    expect(
      resolveAuctionSeedStatus({
        ...base,
        isPublished: true,
        isClosed: true,
      }).status,
    ).toBe("draft");
  });

  it("maps IsDeleted with lots to archived irrespective of closed/published", () => {
    expect(
      resolveAuctionSeedStatus({
        ...withLots,
        isDeleted: true,
        isClosed: true,
        isPublished: true,
      }).status,
    ).toBe("archived");
  });

  it("maps IsClosed with lots to closed irrespective of published when not deleted", () => {
    const result = resolveAuctionSeedStatus({
      ...withLots,
      isClosed: true,
      isPublished: true,
    });
    expect(result.status).toBe("closed");
    expect(result.closedAt).toBe(base.updatedAt);
  });

  it("maps unpublished with lots to draft when not deleted or closed", () => {
    expect(resolveAuctionSeedStatus(withLots).status).toBe("draft");
  });

  it("maps IsPublished with lots to published when not closed or deleted", () => {
    expect(
      resolveAuctionSeedStatus({ ...withLots, isPublished: true }).status,
    ).toBe("published");
  });
});

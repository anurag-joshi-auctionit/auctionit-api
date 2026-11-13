import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";

const { selectQueue, updateCalls } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateCalls: [] as Array<{ set: Record<string, unknown> }>,
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      const resolve = async () => selectQueue.shift() ?? [];
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => resolve());
      chain.then = (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => resolve().then(onFulfilled, onRejected);
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ set: values });
        return {
          where: vi.fn(async () => undefined),
        };
      }),
    })),
  },
}));

const { auctionsService } = await import("./auctions.service.js");
const { pgApplyStaggerCorrection } = await import("./auctions-pg.service.js");

describe("pgApplyStaggerCorrection", () => {
  beforeEach(() => {
    updateCalls.length = 0;
  });

  it("writes the forced value plus the acting admin", async () => {
    await pgApplyStaggerCorrection(42, { isStaggered: false }, 9);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.set).toEqual(
      expect.objectContaining({ isStaggered: false, updatedBy: 9 }),
    );
  });

  it("also supports forcing staggering back on", async () => {
    await pgApplyStaggerCorrection(42, { isStaggered: true }, 9);

    expect(updateCalls[0]?.set).toEqual(
      expect.objectContaining({ isStaggered: true, updatedBy: 9 }),
    );
  });
});

describe("auctionsService.applyStaggerCorrection", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateCalls.length = 0;
  });

  it("rejects when the auction is not published", async () => {
    // assertExists
    selectQueue.push([{ id: 42 }]);
    // pgGetAuctionStatus
    selectQueue.push([{ status: "draft" }]);

    await expect(
      auctionsService.applyStaggerCorrection(42, { isStaggered: false }, 9),
    ).rejects.toThrow(
      AuctionsValidationMessages.STAGGER_CORRECTION_REQUIRES_LIVE,
    );
    expect(updateCalls).toHaveLength(0);
  });
});

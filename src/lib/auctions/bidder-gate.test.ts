import { describe, expect, it, vi } from "vitest";
import { LiveBidMessages } from "@auctionit/messages/auctions";

vi.mock("./ip-restriction.js", () => ({ checkIpRestriction: vi.fn().mockResolvedValue(false) }));

const { bidderGateError } = await import("./bidder-gate.js");

/** Fake tx: execute = participant lookup; `releasedRows` of them carry emd_released. */
function makeTx(participantRows: number, releasedRows: number) {
  const execute = vi.fn().mockResolvedValueOnce({
    rows: Array.from({ length: participantRows }, (_, i) => ({ emd_released: i < releasedRows })),
  });
  return { execute } as unknown as Parameters<typeof bidderGateError>[0];
}

const opts = {
  auctionId: 1,
  lotId: 2,
  bidderId: 7,
  tncBlocked: false,
  ipRestrictionEnabled: false,
  ip: null,
};

describe("bidderGateError EMD-released gate", () => {
  it("rejects a bidder whose EMD for the lot was released at close", async () => {
    expect(await bidderGateError(makeTx(1, 1), opts)).toBe(LiveBidMessages.EMD_BLOCK_REQUIRED);
  });

  it("allows a bidder with a block, a winner, or a post-reopen attach", async () => {
    expect(await bidderGateError(makeTx(1, 0), opts)).toBeNull();
  });

  it("still reports unregistered bidders first", async () => {
    expect(await bidderGateError(makeTx(0, 0), opts)).toBe(LiveBidMessages.NOT_REGISTERED);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { lockBiddersMock, postManyMock } = vi.hoisted(() => ({
  lockBiddersMock: vi.fn(),
  postManyMock: vi.fn(),
}));

vi.mock("./emd-transactions.service.js", () => ({
  emdTransactionsService: {
    lockBidders: (...args: unknown[]) => lockBiddersMock(...args),
    postMany: (...args: unknown[]) => postManyMock(...args),
  },
}));

vi.mock("../db/index.js", () => ({ db: {} }));

const { emdBlocksService } = await import("./emd-blocks.service.js");

const AUCTION_ID = 7;
const BIDDER_ID = 42;
const USER_ID = 1;

/**
 * Stands in for a Drizzle tx: `execute` serves the blocked-balance read and the
 * select chain serves the lookup of the block being superseded.
 */
function makeTx(
  blocked: number,
  superseded: { id: number; blockStatus: string | null; blockLotIds?: number[] | null } | null,
) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(superseded ? [superseded] : []),
  };
  return {
    execute: () => Promise.resolve({ rows: [{ blocked: blocked.toFixed(2) }] }),
    select: () => chain,
  } as never;
}

function reconcile(
  tx: never,
  targetAmount: number,
  blockStatus?: string | null,
  lotIds: number[] | null = [1, 2, 3, 4],
) {
  return emdBlocksService.reconcileBlock(tx, {
    auctionId: AUCTION_ID,
    bidderId: BIDDER_ID,
    targetAmount,
    ...(blockStatus === undefined ? {} : { blockStatus: blockStatus as never }),
    lotIds,
    userId: USER_ID,
  });
}

function postedInputs() {
  expect(postManyMock).toHaveBeenCalledTimes(1);
  return postManyMock.mock.calls[0]![1] as {
    emdType: string;
    amount: number;
    reversesTransactionId?: number;
    blockStatus?: string | null;
    blockLotIds?: number[] | null;
  }[];
}

describe("emdBlocksService.reconcileBlock", () => {
  beforeEach(() => {
    lockBiddersMock.mockReset().mockResolvedValue(undefined);
    postManyMock.mockReset().mockResolvedValue([1]);
  });

  it("posts a single block on first attach", async () => {
    const changed = await reconcile(makeTx(0, null), 100, "full");

    expect(changed).toBe(true);
    expect(postedInputs()).toEqual([
      expect.objectContaining({ emdType: "blocked_bidder_attached", amount: 100 }),
    ]);
  });

  it("re-blocks to the target total rather than adding to the already-blocked amount", async () => {
    const changed = await reconcile(makeTx(100, { id: 11, blockStatus: "full" }), 150, "full");

    expect(changed).toBe(true);
    const inputs = postedInputs();
    // The old block is reversed and the new one carries the whole requirement,
    // so the net debit is 50 — not 150, and not 100 + 150.
    expect(inputs).toEqual([
      expect.objectContaining({
        emdType: "release_block_revised",
        amount: 100,
        reversesTransactionId: 11,
      }),
      expect.objectContaining({ emdType: "blocked_bidder_attached", amount: 150 }),
    ]);
  });

  it("releases the excess when the requirement drops", async () => {
    const changed = await reconcile(makeTx(150, { id: 12, blockStatus: "full" }), 100);

    expect(changed).toBe(true);
    const inputs = postedInputs();
    expect(inputs[0]).toMatchObject({ emdType: "release_block_revised", amount: 150 });
    expect(inputs[1]).toMatchObject({ emdType: "blocked_bidder_attached", amount: 100 });
  });

  it("reverses without re-blocking when the requirement reaches zero", async () => {
    const changed = await reconcile(makeTx(100, { id: 13, blockStatus: "partial" }), 0);

    expect(changed).toBe(true);
    expect(postedInputs()).toEqual([
      expect.objectContaining({ emdType: "release_block_revised", amount: 100 }),
    ]);
  });

  it("does nothing when the block already equals the requirement", async () => {
    const changed = await reconcile(makeTx(100, { id: 14, blockStatus: "full" }), 100);

    expect(changed).toBe(false);
    expect(postManyMock).not.toHaveBeenCalled();
  });

  it("re-posts a same-amount block when the lot snapshot changed", async () => {
    const changed = await reconcile(
      makeTx(100, { id: 16, blockStatus: "full", blockLotIds: [1, 2, 3, 4] }),
      100,
      undefined,
      [1, 2],
    );

    expect(changed).toBe(true);
    const inputs = postedInputs();
    expect(inputs[0]).toMatchObject({ emdType: "release_block_revised", amount: 100, blockLotIds: [1, 2, 3, 4] });
    expect(inputs[1]).toMatchObject({ emdType: "blocked_bidder_attached", amount: 100, blockLotIds: [1, 2] });
  });

  it("does nothing when amount and lot snapshot are both unchanged", async () => {
    const changed = await reconcile(
      makeTx(100, { id: 17, blockStatus: "full", blockLotIds: [4, 3, 2, 1] }),
      100,
    );

    expect(changed).toBe(false);
    expect(postManyMock).not.toHaveBeenCalled();
  });

  it("carries the superseded block status forward when none is given", async () => {
    await reconcile(makeTx(150, { id: 15, blockStatus: "partial" }), 100);

    expect(postedInputs()[1]).toMatchObject({ blockStatus: "partial" });
  });

  it("uses the status the caller passes over the superseded one", async () => {
    await reconcile(makeTx(100, { id: 16, blockStatus: "partial" }), 150, "full");

    expect(postedInputs()[1]).toMatchObject({ blockStatus: "full" });
  });

  it("locks the bidder before reading the blocked balance", async () => {
    await reconcile(makeTx(0, null), 100, "full");

    expect(lockBiddersMock).toHaveBeenCalledWith(expect.anything(), [BIDDER_ID]);
  });

  it("stores the new lot ids on the new block on first attach", async () => {
    await reconcile(makeTx(0, null), 100, "full", [1, 2]);

    expect(postedInputs()).toEqual([
      expect.objectContaining({ emdType: "blocked_bidder_attached", blockLotIds: [1, 2] }),
    ]);
  });

  it("carries the superseded entry's own lot ids on the reversal, not the new ones", async () => {
    await reconcile(
      makeTx(100, { id: 17, blockStatus: "full", blockLotIds: [1, 2] }),
      150,
      "full",
      [1, 2, 4],
    );

    const inputs = postedInputs();
    expect(inputs[0]).toMatchObject({ emdType: "release_block_revised", blockLotIds: [1, 2] });
    expect(inputs[1]).toMatchObject({
      emdType: "blocked_bidder_attached",
      blockLotIds: [1, 2, 4],
    });
  });

  it("stores null on the reversal when the superseded entry predates lot-id tracking", async () => {
    await reconcile(makeTx(100, { id: 18, blockStatus: "full", blockLotIds: null }), 0);

    expect(postedInputs()[0]).toMatchObject({
      emdType: "release_block_revised",
      blockLotIds: null,
    });
  });
});

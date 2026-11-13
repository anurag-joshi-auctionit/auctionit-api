import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmdErrorMessages, EmdValidationMessages } from "@auctionit/messages/emd";

const { lockBiddersMock, postManyMock, availableBalanceMock, runMock } = vi.hoisted(() => ({
  lockBiddersMock: vi.fn(),
  postManyMock: vi.fn(),
  availableBalanceMock: vi.fn(),
  runMock: vi.fn(),
}));

vi.mock("./emd-transactions.service.js", () => ({
  emdTransactionsService: {
    lockBidders: (...args: unknown[]) => lockBiddersMock(...args),
    postMany: (...args: unknown[]) => postManyMock(...args),
    availableBalance: (...args: unknown[]) => availableBalanceMock(...args),
    run: (fn: (tx: unknown) => unknown) => runMock(fn),
  },
}));

vi.mock("../db/index.js", () => ({ db: {} }));

const { emdTransfersService } = await import("./emd-transfers.service.js");

const FROM = 11;
const TO = 22;
const USER = 1;

type TxStub = {
  selectResults: unknown[][];
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
};

/**
 * Stands in for a Drizzle tx. `selectResults` is consumed in call order, so each
 * test lists what its selects should return.
 */
function makeTx(selectResults: unknown[][]) {
  const state: TxStub = { selectResults: [...selectResults], inserted: [], updated: [] };
  const tx: Record<string, unknown> = {
    select: () => {
      const rows = state.selectResults.shift() ?? [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        leftJoin: () => chain,
        limit: () => Promise.resolve(rows),
        for: () => Promise.resolve(rows),
      };
      // Awaiting the chain directly (no .limit/.for) resolves to the rows too.
      (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(rows);
      return chain;
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v);
        return { returning: () => Promise.resolve([{ id: 99 }]) };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        state.updated.push(v);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };
  return { tx: tx as never, state };
}

function runWith(tx: never) {
  runMock.mockImplementation((fn: (t: never) => unknown) => fn(tx));
}

function postedInputs() {
  expect(postManyMock).toHaveBeenCalledTimes(1);
  return postManyMock.mock.calls[0]![1] as {
    bidderId: number;
    emdType: string;
    amount: number;
    transferId: number;
  }[];
}

const ELIGIBLE_BOTH = [{ id: FROM }, { id: TO }];

describe("emdTransfersService.request", () => {
  beforeEach(() => {
    lockBiddersMock.mockReset().mockResolvedValue(undefined);
    postManyMock.mockReset().mockResolvedValue([]);
    availableBalanceMock.mockReset().mockResolvedValue(1000);
    runMock.mockReset();
  });

  it("rejects a transfer to the same bidder", async () => {
    await expect(
      emdTransfersService.request({
        fromBidderId: FROM,
        toBidderId: FROM,
        amount: 100,
        requestedRemarks: "why",
        userId: USER,
      }),
    ).rejects.toThrow();
    expect(runMock).not.toHaveBeenCalled();
  });

  it("rejects when either bidder is not active and verified", async () => {
    const { tx } = makeTx([[{ id: FROM }]]);
    runWith(tx);

    await expect(
      emdTransfersService.request({
        fromBidderId: FROM,
        toBidderId: TO,
        amount: 100,
        requestedRemarks: "why",
        userId: USER,
      }),
    ).rejects.toThrow(EmdErrorMessages.TRANSFER_BIDDER_NOT_ELIGIBLE);
  });

  it("rejects an amount above the source's withdrawable balance", async () => {
    const { tx } = makeTx([ELIGIBLE_BOTH]);
    runWith(tx);
    availableBalanceMock.mockResolvedValue(50);

    await expect(
      emdTransfersService.request({
        fromBidderId: FROM,
        toBidderId: TO,
        amount: 100,
        requestedRemarks: "why",
        userId: USER,
      }),
    ).rejects.toThrow(/withdrawable/i);
  });

  it("inserts the request and posts nothing to the ledger", async () => {
    const { tx, state } = makeTx([ELIGIBLE_BOTH]);
    runWith(tx);

    const result = await emdTransfersService.request({
      fromBidderId: FROM,
      toBidderId: TO,
      amount: 100,
      requestedRemarks: "consolidating wallets",
      userId: USER,
    });

    expect(result).toEqual({ id: 99 });
    expect(state.inserted[0]).toMatchObject({
      fromBidderId: FROM,
      toBidderId: TO,
      amount: "100.00",
      status: "requested",
      requestedRemarks: "consolidating wallets",
    });
    expect(postManyMock).not.toHaveBeenCalled();
  });
});

describe("emdTransfersService.review", () => {
  const pending = {
    id: 7,
    fromBidderId: FROM,
    toBidderId: TO,
    amount: "100.00",
    status: "requested",
    requestedRemarks: "consolidating wallets",
  };

  beforeEach(() => {
    lockBiddersMock.mockReset().mockResolvedValue(undefined);
    postManyMock.mockReset().mockResolvedValue([]);
    availableBalanceMock.mockReset().mockResolvedValue(1000);
    runMock.mockReset();
  });

  it("posts both legs against the one transfer on approval", async () => {
    const { tx, state } = makeTx([
      [pending],
      [
        { id: FROM, name: "Alpha Traders" },
        { id: TO, name: "Beta Metals" },
      ],
    ]);
    runWith(tx);

    const result = await emdTransfersService.review({
      ids: [7],
      approve: true,
      remarks: "approved after check",
      userId: USER,
    });

    expect(result).toEqual({ updated: 1 });
    expect(state.updated[0]).toMatchObject({ status: "approved", reviewedBy: USER });
    expect(postedInputs()).toEqual([
      expect.objectContaining({
        bidderId: FROM,
        emdType: "transfer_out",
        amount: 100,
        transferId: 7,
      }),
      expect.objectContaining({
        bidderId: TO,
        emdType: "transfer_in",
        amount: 100,
        transferId: 7,
      }),
    ]);
  });

  it("names the counterparty on each leg's narration", async () => {
    const { tx } = makeTx([
      [pending],
      [
        { id: FROM, name: "Alpha Traders" },
        { id: TO, name: "Beta Metals" },
      ],
    ]);
    runWith(tx);

    await emdTransfersService.review({ ids: [7], approve: true, remarks: "approved after check", userId: USER });

    const inputs = postManyMock.mock.calls[0]![1] as {
      narrationValues: { counterparty: string };
    }[];
    expect(inputs[0]!.narrationValues.counterparty).toBe("Beta Metals");
    expect(inputs[1]!.narrationValues.counterparty).toBe("Alpha Traders");
  });

  it("posts nothing when rejected", async () => {
    const { tx, state } = makeTx([[pending]]);
    runWith(tx);

    const result = await emdTransfersService.review({
      ids: [7],
      approve: false,
      remarks: "not needed",
      userId: USER,
    });

    expect(result).toEqual({ updated: 1 });
    expect(state.updated[0]).toMatchObject({ status: "rejected", reviewedRemarks: "not needed" });
    expect(postManyMock).not.toHaveBeenCalled();
  });

  it("requires remarks even when approving", async () => {
    const { tx } = makeTx([[pending]]);
    runWith(tx);

    await expect(
      emdTransfersService.review({ ids: [7], approve: true, remarks: "   ", userId: USER }),
    ).rejects.toThrow(EmdValidationMessages.REASON_REQUIRED);
    expect(postManyMock).not.toHaveBeenCalled();
  });

  it("refuses a row that is no longer pending", async () => {
    const { tx } = makeTx([[{ ...pending, status: "approved" }]]);
    runWith(tx);

    await expect(
      emdTransfersService.review({ ids: [7], approve: true, remarks: "approved after check", userId: USER }),
    ).rejects.toThrow(EmdErrorMessages.TRANSFER_INVALID_STATUS);
    expect(postManyMock).not.toHaveBeenCalled();
  });

  it("refuses approval when the source's balance no longer covers it", async () => {
    const { tx } = makeTx([[pending]]);
    runWith(tx);
    availableBalanceMock.mockResolvedValue(40);

    await expect(
      emdTransfersService.review({ ids: [7], approve: true, remarks: "approved after check", userId: USER }),
    ).rejects.toThrow(EmdErrorMessages.TRANSFER_BALANCE_CHANGED);
    expect(postManyMock).not.toHaveBeenCalled();
  });

  it("checks the combined total when one source funds several transfers", async () => {
    const second = { ...pending, id: 8, amount: "70.00" };
    const { tx } = makeTx([[pending, second]]);
    runWith(tx);
    availableBalanceMock.mockResolvedValue(150); // covers 100 or 70, not 170

    await expect(
      emdTransfersService.review({ ids: [7, 8], approve: true, remarks: "approved after check", userId: USER }),
    ).rejects.toThrow(EmdErrorMessages.TRANSFER_BALANCE_CHANGED);
  });

  it("refuses the whole batch when any row is missing", async () => {
    const { tx } = makeTx([[pending]]);
    runWith(tx);

    await expect(
      emdTransfersService.review({ ids: [7, 8], approve: true, remarks: "approved after check", userId: USER }),
    ).rejects.toThrow(EmdErrorMessages.TRANSFER_NOT_FOUND);
  });
});

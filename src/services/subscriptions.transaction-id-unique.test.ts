import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionsValidationMessages } from "@auctionit/messages/subscriptions";

const { selectQueue, updateSetMock } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updateSetMock = vi.fn(() => ({
    where: vi.fn(async () => undefined),
  }));
  return { selectQueue, updateSetMock };
});

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      const resolve = async () => selectQueue.shift() ?? [];
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => resolve());
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.then = (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => resolve().then(onFulfilled, onRejected);
      return chain;
    }),
    update: vi.fn(() => ({
      set: updateSetMock,
    })),
  },
}));

vi.mock("../lib/subscriptions/invoice-r2.js", () => ({
  persistSubscriptionInvoicePdf: vi.fn(),
  signedSubscriptionInvoicePdfUrl: vi.fn(),
}));

vi.mock("./_id.js", () => ({
  nextId: vi.fn(async () => 1),
}));

const { subscriptionsService } = await import("./subscriptions.service.js");

const EXISTING = {
  id: 42,
  bidderId: 9,
  bidderName: "Bidder Co",
  subscriptionTypeId: 1,
  subscriptionTypeName: "Monthly",
  fromDate: "2026-01-01",
  toDate: "2026-01-31",
  subscriptionPrice: 100,
  gstAmount: 18,
  amount: 118,
  paymentMode: 1,
  paymentModeName: "NEFT",
  transactionId: "TXN-1",
  paymentDate: "2026-01-01",
  remarks: null,
  invoiceStatus: "recheck" as const,
  invoiceNumber: null,
  invoiceDate: null,
  invoiceRequestedAt: null,
  invoiceRequestedBy: null,
  invoiceGeneratedAt: null,
  invoiceGeneratedBy: null,
  invoicePdfFilename: null,
  invoicePdfS3Key: null,
  invoicePdfUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
};

const PLAN = {
  id: 1,
  name: "Monthly",
  amount: "118.00",
  gstPercent: "18.00",
  months: 1,
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
};

describe("subscription transaction id uniqueness", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateSetMock.mockReset();
    updateSetMock.mockReturnValue({
      where: vi.fn(async () => undefined),
    });
    vi.spyOn(subscriptionsService, "getById").mockResolvedValue({
      ...EXISTING,
    });
    vi.spyOn(
      subscriptionsService as unknown as { getPlan: (id: number) => Promise<typeof PLAN> },
      "getPlan",
    ).mockResolvedValue(PLAN);
  });

  it("rejects update when another row has the same normalized transaction id", async () => {
    selectQueue.push([{ id: 7 }]); // uniqueness conflict

    await expect(
      subscriptionsService.update(42, {
        subscriptionTypeId: 1,
        amount: 118,
        paymentMode: 1,
        transactionId: " txn 1 ",
        paymentDate: "2026-01-01",
        userId: 1,
      }),
    ).rejects.toMatchObject({
      name: "SubscriptionValidationError",
      message: SubscriptionsValidationMessages.TRANSACTION_ID_DUPLICATE,
      fieldErrors: {
        transactionId: [
          SubscriptionsValidationMessages.TRANSACTION_ID_DUPLICATE,
        ],
      },
    });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("allows update when the normalized transaction id is unique", async () => {
    selectQueue.push([]); // unique
    vi.spyOn(subscriptionsService, "getById")
      .mockResolvedValueOnce({ ...EXISTING })
      .mockResolvedValueOnce({
        ...EXISTING,
        transactionId: "TXN-2",
        invoiceStatus: "requested",
      });

    await expect(
      subscriptionsService.update(42, {
        subscriptionTypeId: 1,
        amount: 118,
        paymentMode: 1,
        transactionId: "TXN-2",
        paymentDate: "2026-01-01",
        status: "requested",
        userId: 1,
      }),
    ).resolves.toMatchObject({ transactionId: "TXN-2" });

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "TXN-2",
      }),
    );
  });

  it("persists plan amount on update even when client sends a different amount", async () => {
    selectQueue.push([]); // unique
    vi.spyOn(subscriptionsService, "getById")
      .mockResolvedValueOnce({ ...EXISTING })
      .mockResolvedValueOnce({ ...EXISTING, invoiceStatus: "requested" });

    await subscriptionsService.update(42, {
      subscriptionTypeId: 1,
      amount: 9999,
      paymentMode: 1,
      transactionId: "TXN-PLAN",
      paymentDate: "2026-01-01",
      status: "requested",
      userId: 1,
    });

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "118.00",
      }),
    );
  });
});

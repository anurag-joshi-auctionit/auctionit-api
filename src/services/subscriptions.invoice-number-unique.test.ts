import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionsValidationMessages } from "@auctionit/messages/subscriptions";

const {
  selectQueue,
  updateSetMock,
  persistSubscriptionInvoicePdfMock,
} = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updateSetMock = vi.fn(() => ({
    where: vi.fn(async () => undefined),
  }));
  const persistSubscriptionInvoicePdfMock = vi.fn(async () => ({
    s3Key: "subs/1/invoice.pdf",
    filename: "invoice.pdf",
  }));
  return { selectQueue, updateSetMock, persistSubscriptionInvoicePdfMock };
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
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
    update: vi.fn(() => ({
      set: updateSetMock,
    })),
  },
}));

vi.mock("../lib/subscriptions/invoice-r2.js", () => ({
  persistSubscriptionInvoicePdf: (...args: unknown[]) =>
    persistSubscriptionInvoicePdfMock(...args),
  signedSubscriptionInvoicePdfUrl: vi.fn(),
}));

vi.mock("./_id.js", () => ({
  nextId: vi.fn(async () => 1),
}));

const {
  subscriptionsService,
  SubscriptionValidationError,
} = await import("./subscriptions.service.js");

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
  transactionId: "TXN",
  paymentDate: "2026-01-01",
  remarks: null,
  invoiceStatus: "requested" as const,
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

describe("subscription invoice number uniqueness", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateSetMock.mockReset();
    updateSetMock.mockReturnValue({
      where: vi.fn(async () => undefined),
    });
    persistSubscriptionInvoicePdfMock.mockClear();
    vi.spyOn(subscriptionsService, "getById").mockResolvedValue({
      ...EXISTING,
    });
  });

  it("uploads when the invoice number is unique", async () => {
    selectQueue.push(
      [], // assert uniqueness
      [], // existing document lookup inside upsert (none)
    );
    vi.spyOn(subscriptionsService, "getById")
      .mockResolvedValueOnce({ ...EXISTING })
      .mockResolvedValueOnce({
        ...EXISTING,
        invoiceNumber: "SUB-INV-1",
        invoiceDate: "2026-08-01",
        invoiceStatus: "generated",
      });

    await expect(
      subscriptionsService.uploadInvoicePdf(
        42,
        { buffer: Buffer.from("%PDF") },
        { invoiceNumber: "SUB-INV-1", invoiceDate: "2026-08-01" },
        1,
      ),
    ).resolves.toMatchObject({ invoiceNumber: "SUB-INV-1" });

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceNumber: "SUB-INV-1",
      }),
    );
  });

  it("rejects when another subscription already has the number", async () => {
    selectQueue.push([{ id: 7 }]); // conflict

    await expect(
      subscriptionsService.uploadInvoicePdf(
        42,
        { buffer: Buffer.from("%PDF") },
        { invoiceNumber: "SUB-INV-1", invoiceDate: "2026-08-01" },
        1,
      ),
    ).rejects.toMatchObject({
      name: "SubscriptionValidationError",
      message: SubscriptionsValidationMessages.INVOICE_NUMBER_DUPLICATE,
      fieldErrors: {
        invoiceNumber: [
          SubscriptionsValidationMessages.INVOICE_NUMBER_DUPLICATE,
        ],
      },
    });
    expect(persistSubscriptionInvoicePdfMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("maps update unique-violation to a field error", async () => {
    selectQueue.push(
      [], // assert uniqueness
      [], // upsert existing doc lookup
    );
    const err = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "subscriptions_invoice_number_uidx",
    });
    updateSetMock.mockReturnValue({
      where: vi.fn(async () => {
        throw err;
      }),
    });

    await expect(
      subscriptionsService.uploadInvoicePdf(
        42,
        { buffer: Buffer.from("%PDF") },
        { invoiceNumber: "SUB-INV-1", invoiceDate: "2026-08-01" },
        1,
      ),
    ).rejects.toBeInstanceOf(SubscriptionValidationError);
  });
});

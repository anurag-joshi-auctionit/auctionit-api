import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceInvoicesValidationMessages } from "@auctionit/messages/service-invoices";

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

const {
  serviceInvoicesService,
  ServiceInvoiceValidationError,
} = await import("./service-invoices.service.js");

const EXISTING = {
  id: 42,
  clientId: 1,
  clientName: "Acme",
  plantLocationId: 2,
  plantLocationName: "Plant",
  fromDate: "2026-01-01T00:00:00.000Z",
  toDate: "2026-01-31T00:00:00.000Z",
  type: "manual" as const,
  orderNumber: null,
  orderDate: null,
  gracePeriod: null,
  totalQuantity: 0,
  totalAmount: 0,
  serviceFeeType: "fixed" as const,
  serviceFeeValue: 100,
  serviceFeeAmount: 100,
  gstPercent: 18,
  gstAmount: 18,
  grandTotal: 118,
  roundOff: null,
  serviceChargeDescription: null,
  invoiceNumber: null,
  invoiceDate: null,
  paymentDueDate: null,
  paidAmount: 0,
  unpaidAmount: 118,
  latestPaymentDate: null,
  paymentStatus: "unpaid" as const,
  annexureXlsxFilename: null,
  annexureXlsxS3Key: null,
  annexureXlsxUrl: null,
  annexurePdfFilename: null,
  annexurePdfS3Key: null,
  annexurePdfUrl: null,
  invoicePdfFilename: null,
  invoicePdfS3Key: null,
  invoicePdfUrl: null,
  hasAnnexure: false,
  status: "requested" as const,
  requestedAt: null,
  requestedBy: null,
  generatedAt: null,
  generatedBy: null,
  emailSentAt: null,
  emailSentBy: null,
  recheckedAt: null,
  recheckedBy: null,
  cancelledAt: null,
  cancelledBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
};

describe("service invoice number uniqueness", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateSetMock.mockReset();
    updateSetMock.mockReturnValue({
      where: vi.fn(async () => undefined),
    });
    vi.spyOn(serviceInvoicesService, "get").mockResolvedValue({ ...EXISTING });
  });

  it("saves when the invoice number is unique", async () => {
    selectQueue.push([]); // assert uniqueness — no conflict
    vi.spyOn(serviceInvoicesService, "get")
      .mockResolvedValueOnce({ ...EXISTING })
      .mockResolvedValueOnce({
        ...EXISTING,
        invoiceNumber: "INV-100",
        invoiceDate: "2026-08-01",
        paymentDueDate: "2026-08-15",
      });

    await expect(
      serviceInvoicesService.accountsUpdate(
        42,
        {
          invoiceNumber: "INV-100",
          invoiceDate: "2026-08-01",
          paymentDueDate: "2026-08-15",
        },
        1,
      ),
    ).resolves.toMatchObject({ invoiceNumber: "INV-100" });

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceNumber: "INV-100",
      }),
    );
  });

  it("rejects when another invoice already has the number", async () => {
    selectQueue.push([{ id: 7 }]); // conflict

    await expect(
      serviceInvoicesService.accountsUpdate(
        42,
        {
          invoiceNumber: "INV-100",
          invoiceDate: "2026-08-01",
          paymentDueDate: "2026-08-15",
        },
        1,
      ),
    ).rejects.toMatchObject({
      name: "ServiceInvoiceValidationError",
      message: ServiceInvoicesValidationMessages.INVOICE_NUMBER_DUPLICATE,
      fieldErrors: {
        invoiceNumber: [
          ServiceInvoicesValidationMessages.INVOICE_NUMBER_DUPLICATE,
        ],
      },
    });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it("allows saving the same number on the current invoice", async () => {
    vi.spyOn(serviceInvoicesService, "get")
      .mockResolvedValueOnce({
        ...EXISTING,
        invoiceNumber: "INV-100",
        invoiceDate: "2026-08-01",
        paymentDueDate: "2026-08-15",
      })
      .mockResolvedValueOnce({
        ...EXISTING,
        invoiceNumber: "INV-100",
        invoiceDate: "2026-08-01",
        paymentDueDate: "2026-08-20",
      });
    selectQueue.push([]); // self excluded — no other conflict

    await expect(
      serviceInvoicesService.accountsUpdate(
        42,
        {
          invoiceNumber: "INV-100",
          invoiceDate: "2026-08-01",
          paymentDueDate: "2026-08-20",
        },
        1,
      ),
    ).resolves.toMatchObject({ invoiceNumber: "INV-100" });
    expect(updateSetMock).toHaveBeenCalled();
  });

  it("maps update unique-violation to a field error", async () => {
    selectQueue.push([]);
    const err = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "service_invoices_invoice_number_uidx",
    });
    updateSetMock.mockReturnValue({
      where: vi.fn(async () => {
        throw err;
      }),
    });

    await expect(
      serviceInvoicesService.accountsUpdate(
        42,
        {
          invoiceNumber: "INV-100",
          invoiceDate: "2026-08-01",
          paymentDueDate: "2026-08-15",
        },
        1,
      ),
    ).rejects.toBeInstanceOf(ServiceInvoiceValidationError);
  });
});

import { describe, expect, it } from "vitest";
import { ServiceInvoicesValidationMessages as M } from "@auctionit/messages/service-invoices";
import {
  accountsServiceInvoiceActionSchema,
  annexureAutoQuerySchema,
  createServiceInvoiceSchema,
  istTodayDateOnly,
  isValidIsoDateOnly,
} from "./schemas.js";

/** Calendar day after IST today as YYYY-MM-DD. */
function istTomorrowDateOnly(): string {
  const today = istTodayDateOnly();
  const [y, m, d] = today.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

describe("isValidIsoDateOnly", () => {
  it("accepts real calendar dates", () => {
    expect(isValidIsoDateOnly("2026-01-31")).toBe(true);
    expect(isValidIsoDateOnly("2024-02-29")).toBe(true);
  });

  it("rejects impossible calendar dates and bad shapes", () => {
    expect(isValidIsoDateOnly("2026-02-31")).toBe(false);
    expect(isValidIsoDateOnly("2025-02-29")).toBe(false);
    expect(isValidIsoDateOnly("2026-1-1")).toBe(false);
    expect(isValidIsoDateOnly("")).toBe(false);
  });
});

describe("accountsServiceInvoiceActionSchema", () => {
  it("requires invoice number, date, and payment due date together", () => {
    const onlyNumber = accountsServiceInvoiceActionSchema.safeParse({
      invoiceNumber: "INV-1",
    });
    expect(onlyNumber.success).toBe(false);
    if (!onlyNumber.success) {
      expect(
        onlyNumber.error.issues.some((i) => i.path[0] === "invoiceDate"),
      ).toBe(true);
      expect(
        onlyNumber.error.issues.some((i) => i.path[0] === "paymentDueDate"),
      ).toBe(true);
    }

    const onlyDate = accountsServiceInvoiceActionSchema.safeParse({
      invoiceDate: "2026-03-01",
    });
    expect(onlyDate.success).toBe(false);
    if (!onlyDate.success) {
      expect(
        onlyDate.error.issues.some((i) => i.path[0] === "invoiceNumber"),
      ).toBe(true);
      expect(
        onlyDate.error.issues.some((i) => i.path[0] === "paymentDueDate"),
      ).toBe(true);
    }

    const missingDue = accountsServiceInvoiceActionSchema.safeParse({
      invoiceNumber: "INV-1",
      invoiceDate: "2026-03-01",
    });
    expect(missingDue.success).toBe(false);
    if (!missingDue.success) {
      expect(
        missingDue.error.issues.some((i) => i.path[0] === "paymentDueDate"),
      ).toBe(true);
    }
  });

  it("accepts all invoice fields when valid", () => {
    const today = istTodayDateOnly();
    const parsed = accountsServiceInvoiceActionSchema.safeParse({
      invoiceNumber: "INV/2026-01",
      invoiceDate: today,
      paymentDueDate: today,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        invoiceNumber: "INV/2026-01",
        invoiceDate: today,
        paymentDueDate: today,
      });
    }
  });

  it("accepts payment due date on or after invoice date", () => {
    const parsed = accountsServiceInvoiceActionSchema.safeParse({
      invoiceNumber: "INV-1",
      invoiceDate: "2026-03-01",
      paymentDueDate: "2026-03-15",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects future invoice date", () => {
    const result = accountsServiceInvoiceActionSchema.safeParse({
      invoiceNumber: "INV-1",
      invoiceDate: istTomorrowDateOnly(),
      paymentDueDate: "2026-03-15",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === M.INVOICE_DATE_FUTURE),
      ).toBe(true);
    }
  });

  it("rejects payment due date before invoice date", () => {
    const result = accountsServiceInvoiceActionSchema.safeParse({
      invoiceNumber: "INV-1",
      invoiceDate: "2026-03-15",
      paymentDueDate: "2026-03-10",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === M.PAYMENT_DUE_DATE_BEFORE_INVOICE_DATE,
        ),
      ).toBe(true);
      expect(
        result.error.issues.some((i) => i.path[0] === "paymentDueDate"),
      ).toBe(true);
    }
  });

  it("rejects null, empty, oversized, and invalid invoice values", () => {
    expect(
      accountsServiceInvoiceActionSchema.safeParse({
        invoiceNumber: null,
        invoiceDate: "2026-03-01",
        paymentDueDate: "2026-03-15",
      }).success,
    ).toBe(false);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({
        invoiceNumber: "   ",
        invoiceDate: "2026-03-01",
        paymentDueDate: "2026-03-15",
      }).success,
    ).toBe(false);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({
        invoiceNumber: "x".repeat(31),
        invoiceDate: "2026-03-01",
        paymentDueDate: "2026-03-15",
      }).success,
    ).toBe(false);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({
        invoiceNumber: "INV<script>",
        invoiceDate: "2026-03-01",
        paymentDueDate: "2026-03-15",
      }).success,
    ).toBe(false);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({
        invoiceNumber: "INV-1",
        invoiceDate: "2026-02-31",
        paymentDueDate: "2026-03-15",
      }).success,
    ).toBe(false);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({
        invoiceNumber: "INV-1",
        invoiceDate: null,
        paymentDueDate: "2026-03-15",
      }).success,
    ).toBe(false);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({
        invoiceNumber: "INV-1",
        invoiceDate: "2026-03-01",
        paymentDueDate: "2026-02-31",
      }).success,
    ).toBe(false);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({
        invoiceNumber: "INV-1",
        invoiceDate: "2026-03-01",
        paymentDueDate: null,
      }).success,
    ).toBe(false);
  });

  it("allows status-only updates", () => {
    expect(
      accountsServiceInvoiceActionSchema.safeParse({ status: "recheck" })
        .success,
    ).toBe(true);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({ status: "generated" })
        .success,
    ).toBe(true);
    expect(
      accountsServiceInvoiceActionSchema.safeParse({ status: "cancelled" })
        .success,
    ).toBe(true);
  });

  it("rejects empty payloads", () => {
    const parsed = accountsServiceInvoiceActionSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(M.ACCOUNTS_ACTION_EMPTY);
    }
  });
});

describe("annexureAutoQuerySchema", () => {
  it("requires client, plant, and period", () => {
    const parsed = annexureAutoQuerySchema.safeParse({
      clientId: "12",
      plantLocationId: "34",
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        clientId: 12,
        plantLocationId: 34,
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
      });
    }
  });

  it("rejects missing period bounds", () => {
    const parsed = annexureAutoQuerySchema.safeParse({
      clientId: 1,
      plantLocationId: 2,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("createServiceInvoiceSchema annexure rules", () => {
  const base = {
    clientId: 1,
    plantLocationId: 2,
    fromDate: "2026-01-01",
    toDate: "2026-01-31",
    type: "auto" as const,
    gracePeriod: 7,
    serviceChargeDescription: "Service charges",
    serviceFeeType: "pmt" as const,
    serviceFeeValue: 100,
    totalQuantity: 10,
    totalAmount: 1000,
    gstPercent: 18,
    status: "requested" as const,
  };

  it("allows auto without annexureFileBase64 (server generates on save)", () => {
    expect(createServiceInvoiceSchema.safeParse(base).success).toBe(true);
  });

  it("requires annexureFileBase64 for manual for all fee types", () => {
    const without = createServiceInvoiceSchema.safeParse({
      ...base,
      type: "manual",
    });
    expect(without.success).toBe(false);
    const withFile = createServiceInvoiceSchema.safeParse({
      ...base,
      type: "manual",
      annexureFileBase64: "AAAA",
    });
    expect(withFile.success).toBe(true);
  });

  it("requires status draft or requested", () => {
    const without = createServiceInvoiceSchema.safeParse({
      ...base,
      status: undefined,
    });
    expect(without.success).toBe(false);
    const draft = createServiceInvoiceSchema.safeParse({
      ...base,
      status: "draft",
    });
    expect(draft.success).toBe(true);
  });

  it("requires annexureFileBase64 for manual fixed_amount", () => {
    const without = createServiceInvoiceSchema.safeParse({
      ...base,
      type: "manual",
      serviceFeeType: "fixed_amount",
      totalQuantity: 0,
      totalAmount: 0,
    });
    expect(without.success).toBe(false);
    const withFile = createServiceInvoiceSchema.safeParse({
      ...base,
      type: "manual",
      serviceFeeType: "fixed_amount",
      totalQuantity: 0,
      totalAmount: 0,
      annexureFileBase64: "AAAA",
    });
    expect(withFile.success).toBe(true);
  });

  it("allows same-day period and rejects to date before from date", () => {
    const sameDay = createServiceInvoiceSchema.safeParse({
      ...base,
      fromDate: "2026-08-13",
      toDate: "2026-08-13",
    });
    expect(sameDay.success).toBe(true);

    const inverted = createServiceInvoiceSchema.safeParse({
      ...base,
      fromDate: "2026-08-14",
      toDate: "2026-08-13",
    });
    expect(inverted.success).toBe(false);
    if (!inverted.success) {
      expect(
        inverted.error.issues.some(
          (i) =>
            i.path[0] === "toDate" && i.message === M.DATE_RANGE_INVALID,
        ),
      ).toBe(true);
    }
  });

  it("rejects missing required fields with field messages", () => {
    const parsed = createServiceInvoiceSchema.safeParse({
      status: "requested",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const byPath = Object.fromEntries(
        parsed.error.issues.map((i) => [String(i.path[0]), i.message]),
      );
      expect(byPath.clientId).toBe(M.CLIENT_REQUIRED);
      expect(byPath.plantLocationId).toBe(M.PLANT_REQUIRED);
      expect(byPath.fromDate).toBe(M.FROM_DATE_REQUIRED);
      expect(byPath.toDate).toBe(M.TO_DATE_REQUIRED);
      expect(byPath.type).toBe(M.TYPE_REQUIRED);
      expect(byPath.gracePeriod).toBe(M.GRACE_PERIOD_REQUIRED);
      expect(byPath.serviceChargeDescription).toBe(M.DESCRIPTION_REQUIRED);
      expect(byPath.serviceFeeType).toBe(M.FEE_TYPE_REQUIRED);
      expect(byPath.serviceFeeValue).toBe(M.FEE_VALUE_REQUIRED);
      expect(byPath.totalQuantity).toBe(M.TOTAL_QUANTITY_REQUIRED);
      expect(byPath.totalAmount).toBe(M.TOTAL_AMOUNT_REQUIRED);
      expect(byPath.gstPercent).toBe(M.GST_PERCENT_REQUIRED);
    }
  });

  it("rejects empty string type/fee type with required messages", () => {
    const parsed = createServiceInvoiceSchema.safeParse({
      ...base,
      type: "",
      serviceFeeType: "",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const byPath = Object.fromEntries(
        parsed.error.issues.map((i) => [String(i.path[0]), i.message]),
      );
      expect(byPath.type).toBe(M.TYPE_REQUIRED);
      expect(byPath.serviceFeeType).toBe(M.FEE_TYPE_REQUIRED);
    }
  });

  it("rejects invalid calendar dates and non-positive fee value", () => {
    const badDate = createServiceInvoiceSchema.safeParse({
      ...base,
      fromDate: "2026-02-31",
    });
    expect(badDate.success).toBe(false);
    if (!badDate.success) {
      expect(
        badDate.error.issues.some(
          (i) =>
            i.path[0] === "fromDate" && i.message === M.FROM_DATE_INVALID,
        ),
      ).toBe(true);
    }

    const zeroFee = createServiceInvoiceSchema.safeParse({
      ...base,
      serviceFeeValue: 0,
    });
    expect(zeroFee.success).toBe(true);

    const negativeFee = createServiceInvoiceSchema.safeParse({
      ...base,
      serviceFeeValue: -1,
    });
    expect(negativeFee.success).toBe(false);
    if (!negativeFee.success) {
      expect(
        negativeFee.error.issues.some(
          (i) =>
            i.path[0] === "serviceFeeValue" &&
            i.message === M.FEE_VALUE_POSITIVE,
        ),
      ).toBe(true);
    }
  });
});

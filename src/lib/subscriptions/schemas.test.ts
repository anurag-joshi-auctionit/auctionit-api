import { SubscriptionsValidationMessages as M } from "@auctionit/messages/subscriptions";
import { describe, expect, it } from "vitest";
import {
  bidderSubscriptionBodySchema,
  createSubscriptionBodySchema,
  subscriptionInvoiceUploadFieldsSchema,
} from "./schemas.js";

function istTodayDateOnly(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

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

const validPayment = {
  subscriptionTypeId: 1,
  amount: 1180,
  paymentMode: 2,
  transactionId: "TXN-1",
  paymentDate: "2026-07-01",
  fromDate: "2026-07-01",
  toDate: "2027-06-30",
  remarks: "Paid",
};

describe("createSubscriptionBodySchema", () => {
  it("accepts a valid admin create body", () => {
    const parsed = createSubscriptionBodySchema.parse({
      bidderId: 10,
      ...validPayment,
    });
    expect(parsed.bidderId).toBe(10);
    expect(parsed.amount).toBe(1180);
    expect(parsed.paymentMode).toBe(2);
  });

  it("rejects missing bidder with message", () => {
    const result = createSubscriptionBodySchema.safeParse(validPayment);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(M.BIDDER_REQUIRED);
    }
  });

  it("rejects zero amount with message", () => {
    const result = createSubscriptionBodySchema.safeParse({
      bidderId: 1,
      ...validPayment,
      amount: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === M.AMOUNT_MUST_BE_POSITIVE,
        ),
      ).toBe(true);
    }
  });

  it("rejects invalid calendar payment date", () => {
    const result = createSubscriptionBodySchema.safeParse({
      bidderId: 1,
      ...validPayment,
      paymentDate: "2026-02-31",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === M.PAYMENT_DATE_INVALID),
      ).toBe(true);
    }
  });

  it("accepts payment date equal to IST today", () => {
    const today = istTodayDateOnly();
    const fromDate = `${today.slice(0, 7)}-01`;
    const parsed = createSubscriptionBodySchema.parse({
      bidderId: 1,
      ...validPayment,
      paymentDate: today,
      fromDate,
      toDate: "2027-08-31",
    });
    expect(parsed.paymentDate).toBe(today);
    expect(parsed.fromDate).toBe(fromDate);
  });

  it("rejects from month before payment month", () => {
    const result = createSubscriptionBodySchema.safeParse({
      bidderId: 1,
      ...validPayment,
      paymentDate: "2026-09-15",
      fromDate: "2026-08-01",
      toDate: "2027-07-31",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === M.FROM_DATE_BEFORE_PAYMENT_MONTH,
        ),
      ).toBe(true);
    }
  });

  it("accepts from month after payment month", () => {
    const parsed = createSubscriptionBodySchema.parse({
      bidderId: 1,
      ...validPayment,
      paymentDate: "2026-07-15",
      fromDate: "2026-09-01",
      toDate: "2027-08-31",
    });
    expect(parsed.fromDate).toBe("2026-09-01");
  });

  it("rejects future payment date", () => {
    const result = createSubscriptionBodySchema.safeParse({
      bidderId: 1,
      ...validPayment,
      paymentDate: istTomorrowDateOnly(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === M.PAYMENT_DATE_FUTURE),
      ).toBe(true);
    }
  });

  it("normalizes empty optional strings to null", () => {
    const parsed = createSubscriptionBodySchema.parse({
      bidderId: 1,
      ...validPayment,
      remarks: "   ",
    });
    expect(parsed.remarks).toBeNull();
  });

  it("rejects missing from date", () => {
    const result = createSubscriptionBodySchema.safeParse({
      bidderId: 1,
      ...validPayment,
      fromDate: "  ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === M.FROM_DATE_REQUIRED),
      ).toBe(true);
    }
  });

  it("rejects missing to date", () => {
    const result = createSubscriptionBodySchema.safeParse({
      bidderId: 1,
      ...validPayment,
      toDate: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === M.TO_DATE_REQUIRED),
      ).toBe(true);
    }
  });

  it("rejects missing transaction reference", () => {
    const result = createSubscriptionBodySchema.safeParse({
      bidderId: 1,
      ...validPayment,
      transactionId: "  ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === M.TRANSACTION_ID_REQUIRED,
        ),
      ).toBe(true);
    }
  });

  it("rejects oversized transaction id", () => {
    const result = createSubscriptionBodySchema.safeParse({
      bidderId: 1,
      ...validPayment,
      transactionId: "x".repeat(101),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === M.TRANSACTION_ID_MAX),
      ).toBe(true);
    }
  });
});

describe("bidderSubscriptionBodySchema", () => {
  it("accepts payment fields without bidderId", () => {
    const parsed = bidderSubscriptionBodySchema.parse(validPayment);
    expect(parsed.subscriptionTypeId).toBe(1);
    expect(parsed.paymentMode).toBe(2);
  });

  it("rejects missing payment mode", () => {
    const { paymentMode: _, ...rest } = validPayment;
    const result = bidderSubscriptionBodySchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === M.PAYMENT_MODE_REQUIRED),
      ).toBe(true);
    }
  });
});

describe("subscriptionInvoiceUploadFieldsSchema", () => {
  it("accepts invoice date equal to IST today", () => {
    const today = istTodayDateOnly();
    const parsed = subscriptionInvoiceUploadFieldsSchema.parse({
      invoiceNumber: "INV-1",
      invoiceDate: today,
    });
    expect(parsed.invoiceDate).toBe(today);
  });

  it("rejects future invoice date", () => {
    const result = subscriptionInvoiceUploadFieldsSchema.safeParse({
      invoiceNumber: "INV-1",
      invoiceDate: istTomorrowDateOnly(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message === M.INVOICE_DATE_FUTURE),
      ).toBe(true);
    }
  });
});

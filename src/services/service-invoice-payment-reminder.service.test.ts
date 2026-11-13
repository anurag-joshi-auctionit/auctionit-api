import { describe, expect, it } from "vitest";
import {
  dueDatesForAfterReminders,
  dueDatesForBeforeReminders,
  formatPaymentDueDateDdMmmYyyy,
  getIstCalendarParts,
  isEligibleForPaymentReminder,
  SI_PAYMENT_REMINDER_EXCLUDED_CLIENT_ID,
  SI_PAYMENT_REMINDER_HOUR_GATE,
} from "../services/service-invoice-payment-reminder.service.js";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate } from "@auctionit/lib/date";

const eligibleBase = {
  paymentDueDate: "2026-08-17",
  emailSentAt: "2026-08-01T10:00:00.000Z",
  paymentStatus: "unpaid",
  clientId: 1,
  status: "generated",
  billingEmailTo: "billing@example.com",
};

describe("getIstCalendarParts", () => {
  it("reads Asia/Kolkata calendar day and hour", () => {
    // 2026-08-12 04:30 UTC = 10:00 IST
    const parts = getIstCalendarParts(new Date("2026-08-12T04:30:00.000Z"));
    expect(parts.dateOnly).toBe("2026-08-12");
    expect(parts.hour).toBe(10);
  });

  it("is before the reminder hour gate earlier in the morning", () => {
    // 2026-08-12 03:30 UTC = 09:00 IST
    const parts = getIstCalendarParts(new Date("2026-08-12T03:30:00.000Z"));
    expect(parts.hour).toBeLessThan(SI_PAYMENT_REMINDER_HOUR_GATE);
  });
});

describe("due date offsets", () => {
  it("matches legacy before-due offsets 5/2/1", () => {
    expect(dueDatesForBeforeReminders("2026-08-12")).toEqual([
      "2026-08-17",
      "2026-08-14",
      "2026-08-13",
    ]);
  });

  it("matches legacy after-due offsets 1/3", () => {
    expect(dueDatesForAfterReminders("2026-08-12")).toEqual([
      "2026-08-11",
      "2026-08-09",
    ]);
  });
});

describe("formatters", () => {
  it("formats payment due with app-wide date helper", () => {
    expect(formatPaymentDueDateDdMmmYyyy("2026-08-17")).toBe(
      formatDate("2026-08-17"),
    );
    expect(formatDate("2026-08-17")).toBe("17 Aug 2026");
  });

  it("formats amount with app-wide currency helper", () => {
    expect(formatCurrency(1234.5, { fractionDigits: 2 })).toMatch(/1,234\.50/);
  });
});

describe("isEligibleForPaymentReminder", () => {
  it("accepts generated unpaid emailed invoices with billing To", () => {
    expect(isEligibleForPaymentReminder(eligibleBase)).toBe(true);
  });

  it("skips paid invoices", () => {
    expect(
      isEligibleForPaymentReminder({ ...eligibleBase, paymentStatus: "paid" }),
    ).toBe(false);
  });

  it("skips when invoice email was never sent", () => {
    expect(
      isEligibleForPaymentReminder({ ...eligibleBase, emailSentAt: null }),
    ).toBe(false);
  });

  it("skips when payment due date is missing", () => {
    expect(
      isEligibleForPaymentReminder({ ...eligibleBase, paymentDueDate: null }),
    ).toBe(false);
  });

  it("skips client 9", () => {
    expect(
      isEligibleForPaymentReminder({
        ...eligibleBase,
        clientId: SI_PAYMENT_REMINDER_EXCLUDED_CLIENT_ID,
      }),
    ).toBe(false);
  });

  it("skips missing billing To", () => {
    expect(
      isEligibleForPaymentReminder({
        ...eligibleBase,
        billingEmailTo: "  ",
      }),
    ).toBe(false);
  });

  it("skips non-generated status", () => {
    expect(
      isEligibleForPaymentReminder({ ...eligibleBase, status: "draft" }),
    ).toBe(false);
  });

  it("allows partially_paid", () => {
    expect(
      isEligibleForPaymentReminder({
        ...eligibleBase,
        paymentStatus: "partially_paid",
      }),
    ).toBe(true);
  });
});

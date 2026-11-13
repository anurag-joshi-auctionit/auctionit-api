import { describe, expect, it } from "vitest";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate } from "@auctionit/lib/date";
import { addDaysToDateOnly } from "./date-only.js";
import {
  buildServiceInvoicePaymentReminderAfterDueHtml,
  buildServiceInvoicePaymentReminderAfterDueSubject,
} from "./service-invoice-payment-reminder-after-due-email-template.js";
import {
  buildServiceInvoicePaymentReminderBeforeDueHtml,
  buildServiceInvoicePaymentReminderBeforeDueSubject,
  SERVICE_INVOICE_PAYMENT_REMINDER_CONTACT_EMAIL,
  SERVICE_INVOICE_PAYMENT_REMINDER_CONTACT_MOBILE,
} from "./service-invoice-payment-reminder-before-due-email-template.js";

const vars = {
  invoiceNumber: "SI-100",
  amount: formatCurrency(1234, { fractionDigits: 2 }),
  paymentDueDate: formatDate("2026-08-17"),
};

describe("payment reminder templates", () => {
  it("builds before-due subject and body with placeholders", () => {
    expect(buildServiceInvoicePaymentReminderBeforeDueSubject(vars)).toBe(
      "Invoice Payment Reminder - SI-100",
    );
    const html = buildServiceInvoicePaymentReminderBeforeDueHtml(vars);
    expect(html).toContain("#SI-100");
    expect(html).toContain("approaching the due date");
    expect(html).toContain(vars.amount);
    expect(html).toContain(vars.paymentDueDate);
    expect(html).toContain(SERVICE_INVOICE_PAYMENT_REMINDER_CONTACT_EMAIL);
    expect(html).toContain(SERVICE_INVOICE_PAYMENT_REMINDER_CONTACT_MOBILE);
    expect(html).not.toContain("<!DOCTYPE");
  });

  it("builds after-due subject and body with placeholders", () => {
    expect(buildServiceInvoicePaymentReminderAfterDueSubject(vars)).toBe(
      "Invoice Payment Reminder - SI-100",
    );
    const html = buildServiceInvoicePaymentReminderAfterDueHtml(vars);
    expect(html).toContain("#SI-100");
    expect(html).toContain("has become overdue on");
    expect(html).toContain(vars.amount);
    expect(html).toContain(vars.paymentDueDate);
    expect(html).not.toContain("<!DOCTYPE");
  });
});

describe("date-only offsets used by reminders", () => {
  it("computes before/after due target dates", () => {
    const today = "2026-08-12";
    expect([5, 2, 1].map((d) => addDaysToDateOnly(today, d))).toEqual([
      "2026-08-17",
      "2026-08-14",
      "2026-08-13",
    ]);
    expect([1, 3].map((d) => addDaysToDateOnly(today, -d))).toEqual([
      "2026-08-11",
      "2026-08-09",
    ]);
  });
});

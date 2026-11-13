import { describe, expect, it } from "vitest";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate, formatMonthYearShort } from "@auctionit/lib/date";
import { buildServiceInvoiceEmailHtml } from "./service-invoice-email-template.js";

const baseVars = {
  billingName: "Acme Billing",
  invoiceNumber: "INV-1",
  invoiceDate: formatDate("2026-08-12"),
  amount: formatCurrency(1234, { fractionDigits: 2 }),
  invoiceMonthYear: formatMonthYearShort("2026-08-12"),
  companyName: "Acme",
  plantLocationName: "Plant A",
};

describe("buildServiceInvoiceEmailHtml", () => {
  it("includes annexure detail phrasing by default", () => {
    const html = buildServiceInvoiceEmailHtml(baseVars);
    expect(html).toContain(
      `for the services rendered in ${baseVars.invoiceMonthYear} along with detail.`,
    );
    expect(html).toContain("Dear Acme Billing,");
    expect(html).toContain(baseVars.amount);
  });

  it("defaults greeting to Sir/Madam when billing name is empty", () => {
    const html = buildServiceInvoiceEmailHtml({
      ...baseVars,
      billingName: "  ",
    });
    expect(html).toContain("Dear Sir/Madam,");
  });

  it("omits annexure detail phrasing for fixed-fee invoices", () => {
    const html = buildServiceInvoiceEmailHtml({
      ...baseVars,
      includeAnnexureDetail: false,
    });
    expect(html).toContain(
      `for the services rendered in ${baseVars.invoiceMonthYear}.`,
    );
    expect(html).not.toContain("along with detail");
  });
});

describe("app-wide formatters used by service invoice emails", () => {
  it("formats date and month year", () => {
    expect(formatDate("2026-08-12")).toBe("12 Aug 2026");
    expect(formatMonthYearShort("2026-08-12")).toBe("Aug 2026");
  });

  it("formats currency", () => {
    expect(formatCurrency(1234, { fractionDigits: 2 })).toMatch(/1,234\.00/);
  });
});

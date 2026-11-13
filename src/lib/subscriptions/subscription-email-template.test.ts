import { describe, expect, it } from "vitest";
import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate } from "@auctionit/lib/date";
import {
  buildSubscriptionEmailHtml,
  buildSubscriptionEmailSubject,
} from "./subscription-email-template.js";

const baseVars = {
  invoiceNumber: "SUB-001",
  invoiceDate: formatDate("2026-08-12"),
  amount: formatCurrency(1180, { fractionDigits: 2 }),
  subscriptionTypeName: "Annual",
};

describe("buildSubscriptionEmailSubject", () => {
  it("returns legacy subject", () => {
    expect(buildSubscriptionEmailSubject()).toBe("Your Subscription Invoice");
  });
});

describe("buildSubscriptionEmailHtml", () => {
  it("includes body fields with app-wide formats", () => {
    const html = buildSubscriptionEmailHtml(baseVars);
    expect(html).toContain("Dear Sir/Madam,");
    expect(html).toContain(`Invoice no.SUB-001 dated ${baseVars.invoiceDate}`);
    expect(html).toContain(`${baseVars.amount} (Inclusive of GST)`);
    expect(html).toContain("for the period Annual");
    expect(html).toContain("Team AuctionIt");
  });

  it("escapes HTML in dynamic fields", () => {
    const html = buildSubscriptionEmailHtml({
      ...baseVars,
      invoiceNumber: "<script>",
      subscriptionTypeName: "A & B",
    });
    expect(html).toContain("Invoice no.&lt;script&gt;");
    expect(html).toContain("for the period A &amp; B");
    expect(html).not.toContain("<script>");
  });
});

describe("app-wide formatters used by subscription emails", () => {
  it("formats date and currency", () => {
    expect(formatDate("2026-08-12")).toBe("12 Aug 2026");
    expect(formatCurrency(1180, { fractionDigits: 2 })).toMatch(/1,180\.00/);
  });
});

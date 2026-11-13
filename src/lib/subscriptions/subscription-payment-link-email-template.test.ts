import { describe, expect, it } from "vitest";
import { formatCurrency } from "@auctionit/lib/currency";
import {
  buildSubscriptionPaymentLinkEmailHtml,
  buildSubscriptionPaymentLinkEmailSubject,
} from "./subscription-payment-link-email-template.js";

const baseVars = {
  companyName: "Acme Traders",
  planName: "Annual",
  amount: formatCurrency(1180, { fractionDigits: 2 }),
  paymentUrl: "https://test.instamojo.com/order/abc",
};

describe("buildSubscriptionPaymentLinkEmailSubject", () => {
  it("returns branded subject", () => {
    expect(buildSubscriptionPaymentLinkEmailSubject()).toBe(
      "Your AuctionIt Subscription Payment Link",
    );
  });
});

describe("buildSubscriptionPaymentLinkEmailHtml", () => {
  it("includes amount, plan, company, and payment link", () => {
    const html = buildSubscriptionPaymentLinkEmailHtml(baseVars);
    expect(html).toContain("Dear Sir/Madam,");
    expect(html).toContain(`${baseVars.amount} (Inclusive of GST)`);
    expect(html).toContain(`(${baseVars.planName}) for ${baseVars.companyName}`);
    expect(html).toContain(`href="${baseVars.paymentUrl}"`);
    expect(html).toContain("Pay Subscription Now");
    expect(html).toContain(baseVars.paymentUrl);
    expect(html).toContain("Team AuctionIt");
  });

  it("escapes HTML in dynamic fields", () => {
    const html = buildSubscriptionPaymentLinkEmailHtml({
      ...baseVars,
      companyName: "A & B <Co>",
      planName: "<script>",
      paymentUrl: "https://example.com/?q=a&b=1",
    });
    expect(html).toContain("A &amp; B &lt;Co&gt;");
    expect(html).toContain("(&lt;script&gt;)");
    expect(html).toContain("https://example.com/?q=a&amp;b=1");
    expect(html).not.toContain("<script>");
  });
});

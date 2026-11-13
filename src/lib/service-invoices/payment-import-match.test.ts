import { describe, expect, it } from "vitest";
import { paymentImportInvoicePairIssue } from "./payment-import-match.js";

describe("paymentImportInvoicePairIssue", () => {
  it("attributes a missing invoice to the invoice id", () => {
    expect(
      paymentImportInvoicePairIssue({
        invoiceFound: false,
        numberMatches: false,
      }),
    ).toBe("id-not-found");
  });

  it("attributes a number that does not match to the combo field", () => {
    expect(
      paymentImportInvoicePairIssue({
        invoiceFound: true,
        numberMatches: false,
      }),
    ).toBe("combo");
  });

  it("accepts a matching pair", () => {
    expect(
      paymentImportInvoicePairIssue({
        invoiceFound: true,
        numberMatches: true,
      }),
    ).toBeNull();
  });
});

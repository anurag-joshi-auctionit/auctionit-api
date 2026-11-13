import { describe, expect, it } from "vitest";
import { SubscriptionsValidationMessages as M } from "@auctionit/messages/subscriptions";
import {
  invoiceImportFieldErrorsToIssues,
  normalizePdfBasename,
  parseSubscriptionInvoiceImportSheetRows,
} from "./invoice-import-parse.js";
import { subscriptionInvoiceImportRowSchema } from "./invoice-import-schema.js";
import { istTodayDateOnly } from "./schemas.js";

describe("normalizePdfBasename", () => {
  it("strips path and lowercases", () => {
    expect(normalizePdfBasename("Foo.PDF")).toBe("foo.pdf");
    expect(normalizePdfBasename("C:\\\\docs\\\\Bar.Pdf")).toBe("bar.pdf");
    expect(normalizePdfBasename("folder/nested/x.pdf")).toBe("x.pdf");
  });
});

describe("subscriptionInvoiceImportRowSchema", () => {
  const today = istTodayDateOnly();

  it("accepts a valid row", () => {
    const parsed = subscriptionInvoiceImportRowSchema.parse({
      invoiceId: 10,
      bidderId: 20,
      invoiceNo: "INV-1",
      invoiceDate: today,
      invoicePdfFilename: "inv-1.pdf",
    });
    expect(parsed.invoiceNo).toBe("INV-1");
  });

  it("rejects a future invoice date", () => {
    const result = subscriptionInvoiceImportRowSchema.safeParse({
      invoiceId: 10,
      bidderId: 20,
      invoiceNo: "INV-1",
      invoiceDate: "2099-01-01",
      invoicePdfFilename: "inv-1.pdf",
    });
    expect(result.success).toBe(false);
  });
});

describe("parseSubscriptionInvoiceImportSheetRows", () => {
  it("parses header + valid rows in template column order", () => {
    const result = parseSubscriptionInvoiceImportSheetRows([
      ["Invoice Id", "Bidder", "Invoice no", "Invoice PDF"],
      [101, 55, "INV-A", "a.pdf"],
      [102, 56, "INV-B", "b.pdf"],
    ]);
    expect(result.headerError).toBeUndefined();
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.data.invoiceId).toBe(101);
    expect(result.rows[0]?.data.bidderId).toBe(55);
    expect(result.rows[0]?.data.invoiceNo).toBe("INV-A");
    expect(result.rows[0]?.data.invoicePdfFilename).toBe("a.pdf");
    expect(result.rows[0]?.data.invoiceDate).toBe(istTodayDateOnly());
  });

  it("accepts legacy header aliases", () => {
    const result = parseSubscriptionInvoiceImportSheetRows([
      ["Invoice Id", "Bidder Id", "Invoice No.", "Invoice PDF"],
      [101, 55, "INV-A", "a.pdf"],
    ]);
    expect(result.headerError).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.data.bidderId).toBe(55);
  });

  it("reports missing headers", () => {
    const result = parseSubscriptionInvoiceImportSheetRows([
      ["Invoice Id", "Bidder"],
      [1, 2],
    ]);
    expect(result.headerError).toContain("Missing required column");
    expect(result.rows).toHaveLength(0);
  });

  it("skips blank rows and collects field errors", () => {
    const result = parseSubscriptionInvoiceImportSheetRows([
      ["Invoice Id", "Bidder", "Invoice no", "Invoice PDF"],
      [null, null, null, null],
      ["bad", 1, "INV", "x.pdf"],
    ]);
    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors.length).toBeGreaterThan(0);
    const issues = invoiceImportFieldErrorsToIssues(result.rowErrors);
    expect(issues[0]?.kind).toBe("error");
  });

  it("flags combo-related ids as numbers for apply-phase mismatch", () => {
    const result = parseSubscriptionInvoiceImportSheetRows([
      ["Invoice Id", "Bidder", "Invoice no", "Invoice PDF"],
      [999, 888, "INV-Z", "z.pdf"],
    ]);
    expect(result.rows[0]?.data).toMatchObject({
      invoiceId: 999,
      bidderId: 888,
    });
  });
});

describe("invoice import messages", () => {
  it("exposes combo mismatch copy", () => {
    expect(M.INVOICE_IMPORT_COMBO_MISMATCH).toBe(
      "Invoice ID and Bidder ID combo do not match.",
    );
    expect(M.INVOICE_IMPORT_INVOICE_ID_NOT_FOUND).toBe("Invoice ID not found.");
  });
});

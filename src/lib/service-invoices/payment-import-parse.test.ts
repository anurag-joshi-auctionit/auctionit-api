import { describe, expect, it } from "vitest";
import { ServiceInvoicesValidationMessages as M } from "@auctionit/messages/service-invoices";
import { parseServiceInvoicePaymentImportSheetRows } from "./payment-import-parse.js";

const HEADER = ["invoiceId", "invoiceNo", "paidAmount", "paidAt"];

describe("parseServiceInvoicePaymentImportSheetRows", () => {
  it("parses valid rows", () => {
    const result = parseServiceInvoicePaymentImportSheetRows([
      HEADER,
      [101, "INV-001", 1500.5, "2026-03-15"],
      [102, "INV-002", 200, new Date(2026, 2, 20)],
    ]);

    expect(result.headerError).toBeUndefined();
    expect(result.rowErrors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      rowNumber: 2,
      data: {
        invoiceId: 101,
        invoiceNo: "INV-001",
        paidAmount: 1500.5,
        paidAt: "2026-03-15",
      },
    });
    expect(result.rows[1]?.data.paidAt).toBe("2026-03-20");
  });

  it("reports missing headers", () => {
    const result = parseServiceInvoicePaymentImportSheetRows([
      ["invoiceId", "paidAmount"],
      [1, 100],
    ]);
    expect(result.headerError).toContain("Invoice No.");
    expect(result.headerError).toContain("Paid At");
    expect(result.rows).toHaveLength(0);
  });

  it("parses display label headers", () => {
    const result = parseServiceInvoicePaymentImportSheetRows([
      ["Invoice ID", "Invoice No.", "Paid Amount", "Paid At"],
      [101, "INV-001", 1500.5, "2026-03-15"],
    ]);
    expect(result.headerError).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.data.invoiceId).toBe(101);
  });

  it("reports field errors for invalid amounts and ids", () => {
    const result = parseServiceInvoicePaymentImportSheetRows([
      HEADER,
      ["", "INV-1", 0, "2026-01-01"],
      [5, "", -10, "not-a-date"],
      ["abc", "INV-3", 10, "2026-01-01"],
      [1.5, "INV-4", 10, "2026-01-01"],
      [6, "INV-5", "abc", "2026-01-01"],
    ]);

    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors).toHaveLength(5);

    const first = result.rowErrors[0]!;
    expect(first.rowNumber).toBe(2);
    expect(first.fieldErrors.invoiceId?.[0]).toBe(
      M.PAYMENT_IMPORT_INVOICE_ID_REQUIRED,
    );
    expect(first.fieldErrors.paidAmount?.[0]).toBe(M.PAID_AMOUNT_POSITIVE);

    const second = result.rowErrors[1]!;
    expect(second.fieldErrors.invoiceNo?.[0]).toBe(
      M.PAYMENT_IMPORT_INVOICE_NO_REQUIRED,
    );
    expect(second.fieldErrors.paidAt?.[0]).toBe(M.PAID_AT_INVALID);

    const nonNumericId = result.rowErrors[2]!;
    expect(nonNumericId.fieldErrors.invoiceId?.[0]).toBe(
      M.PAYMENT_IMPORT_INVOICE_ID_INVALID,
    );

    const decimalId = result.rowErrors[3]!;
    expect(decimalId.fieldErrors.invoiceId?.[0]).toBe(
      M.PAYMENT_IMPORT_INVOICE_ID_INVALID,
    );

    const nonNumericAmount = result.rowErrors[4]!;
    expect(nonNumericAmount.fieldErrors.paidAmount?.[0]).toBe(
      M.PAID_AMOUNT_INVALID,
    );
  });

  it("reports required paid amount when cell is blank", () => {
    const result = parseServiceInvoicePaymentImportSheetRows([
      HEADER,
      [1, "INV-1", "", "2026-01-01"],
    ]);
    expect(result.rowErrors).toHaveLength(1);
    expect(result.rowErrors[0]?.fieldErrors.paidAmount?.[0]).toBe(
      M.PAID_AMOUNT_REQUIRED,
    );
  });

  it("maps unparseable paidAt to service-invoice invalid message", () => {
    const result = parseServiceInvoicePaymentImportSheetRows([
      HEADER,
      [1, "INV-1", 10, "not-a-date"],
      [2, "INV-2", 10, "06/03/2026"],
    ]);

    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors).toHaveLength(2);
    expect(result.rowErrors[0]?.fieldErrors.paidAt?.[0]).toBe(M.PAID_AT_INVALID);
    expect(result.rowErrors[1]?.fieldErrors.paidAt?.[0]).toBe(M.PAID_AT_INVALID);
  });

  it("skips blank rows", () => {
    const result = parseServiceInvoicePaymentImportSheetRows([
      HEADER,
      [1, "A", 10, "2026-01-01"],
      ["", "", "", ""],
      [2, "B", 20, "2026-01-02"],
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rowErrors).toHaveLength(0);
  });

  it("returns empty-sheet header error for empty matrix", () => {
    const result = parseServiceInvoicePaymentImportSheetRows([]);
    expect(result.headerError).toBe(M.PAYMENT_IMPORT_SPREADSHEET_EMPTY);
  });
});

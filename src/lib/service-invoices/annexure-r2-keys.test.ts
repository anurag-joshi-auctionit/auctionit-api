import { describe, expect, it } from "vitest";
import {
  buildServiceInvoiceAnnexureFilename,
  buildServiceInvoiceAnnexurePdfFilename,
  buildServiceInvoiceAnnexurePdfS3Key,
  buildServiceInvoiceAnnexureS3Key,
  buildServiceInvoiceInvoicePdfFilename,
  buildServiceInvoiceInvoicePdfS3Key,
} from "./annexure-r2-keys.js";
import { buildServiceInvoiceAnnexureXlsxFromLines } from "./annexure-template.js";
import { parseServiceInvoiceAnnexureBuffer } from "./annexure-parse.js";

describe("annexure R2 keys", () => {
  it("builds stable keys with invoice and client only", () => {
    expect(
      buildServiceInvoiceAnnexureS3Key({
        invoiceId: 42,
        clientId: 7,
      }),
    ).toBe("service-invoices/annexure_xlsx_42_7.xlsx");
    expect(
      buildServiceInvoiceAnnexureFilename({
        invoiceId: 42,
        clientId: 7,
      }),
    ).toBe("annexure_xlsx_42_7.xlsx");
    expect(
      buildServiceInvoiceAnnexurePdfS3Key({
        invoiceId: 42,
        clientId: 7,
      }),
    ).toBe("service-invoices/annexure_pdf_42_7.pdf");
    expect(
      buildServiceInvoiceAnnexurePdfFilename({
        invoiceId: 42,
        clientId: 7,
      }),
    ).toBe("annexure_pdf_42_7.pdf");
    expect(
      buildServiceInvoiceInvoicePdfS3Key({
        invoiceId: 42,
        clientId: 7,
      }),
    ).toBe("service-invoices/invoice_pdf_42_7.pdf");
    expect(
      buildServiceInvoiceInvoicePdfFilename({
        invoiceId: 42,
        clientId: 7,
      }),
    ).toBe("invoice_pdf_42_7.pdf");
  });
});

describe("annexure generate → parse round-trip", () => {
  it("builds xlsx that parses back to the same totals", async () => {
    const lines = [
      {
        lineOrder: 1,
        auctionNumber: "AUC-1",
        auctionDate: "2026-01-15",
        lotNumber: "L-1",
        product: "MS Scrap",
        approvedQty: 10,
        uom: "MT",
        rankLabel: "Winning" as const,
        winningPrice: 100,
        bidderName: "Acme",
        liftedQty: 2,
        amount: 200,
      },
    ];
    const buffer = await buildServiceInvoiceAnnexureXlsxFromLines(lines);
    const parsed = await parseServiceInvoiceAnnexureBuffer(buffer);
    expect(parsed.imported).toBe(1);
    expect(parsed.totals).toEqual({ totalQuantity: 2, totalAmount: 200 });
    expect(parsed.lines?.[0]).toMatchObject({
      auctionNumber: "AUC-1",
      lotNumber: "L-1",
      liftedQty: 2,
      amount: 200,
    });
  });
});

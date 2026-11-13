import { describe, expect, it } from "vitest";
import {
  LEGACY_SERVICE_INVOICE_DOCUMENT_TYPE_PREFIXES,
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
  SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
  SERVICE_INVOICE_DOCUMENT_TYPE_NAMES,
  legacyServiceInvoiceDocumentTypePrefix,
} from "./service-invoice-document-naming.js";

describe("service invoice document naming", () => {
  it("maps fixed type ids to prefixes and names", () => {
    expect(SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX).toBe(1);
    expect(SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF).toBe(2);
    expect(SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF).toBe(3);
    expect(LEGACY_SERVICE_INVOICE_DOCUMENT_TYPE_PREFIXES[1]).toBe(
      "annexure_xlsx_",
    );
    expect(LEGACY_SERVICE_INVOICE_DOCUMENT_TYPE_PREFIXES[2]).toBe(
      "annexure_pdf_",
    );
    expect(LEGACY_SERVICE_INVOICE_DOCUMENT_TYPE_PREFIXES[3]).toBe(
      "invoice_pdf_",
    );
    expect(SERVICE_INVOICE_DOCUMENT_TYPE_NAMES[1]).toBe("Annexure XLSX");
    expect(SERVICE_INVOICE_DOCUMENT_TYPE_NAMES[2]).toBe("Annexure PDF");
    expect(SERVICE_INVOICE_DOCUMENT_TYPE_NAMES[3]).toBe("Invoice PDF");
  });

  it("falls back for unknown type ids", () => {
    expect(legacyServiceInvoiceDocumentTypePrefix(99)).toBe("document_");
  });
});

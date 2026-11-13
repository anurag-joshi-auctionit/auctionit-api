export const SI_ANNEXURE_R2_PREFIX = "service-invoices";
export const SI_ANNEXURE_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const SI_PDF_CONTENT_TYPE = "application/pdf";

/**
 * R2 object key + storage filename (stable 1:1 per invoice + client).
 * Pattern: `service-invoices/annexure_xlsx_{invoiceId}_{clientId}.xlsx`
 */
export function buildServiceInvoiceAnnexureS3Key(opts: {
  invoiceId: number;
  clientId: number;
}): string {
  return `${SI_ANNEXURE_R2_PREFIX}/annexure_xlsx_${opts.invoiceId}_${opts.clientId}.xlsx`;
}

export function buildServiceInvoiceAnnexureFilename(opts: {
  invoiceId: number;
  clientId: number;
}): string {
  return `annexure_xlsx_${opts.invoiceId}_${opts.clientId}.xlsx`;
}

export function buildServiceInvoiceAnnexurePdfS3Key(opts: {
  invoiceId: number;
  clientId: number;
}): string {
  return `${SI_ANNEXURE_R2_PREFIX}/annexure_pdf_${opts.invoiceId}_${opts.clientId}.pdf`;
}

export function buildServiceInvoiceAnnexurePdfFilename(opts: {
  invoiceId: number;
  clientId: number;
}): string {
  return `annexure_pdf_${opts.invoiceId}_${opts.clientId}.pdf`;
}

export function buildServiceInvoiceInvoicePdfS3Key(opts: {
  invoiceId: number;
  clientId: number;
}): string {
  return `${SI_ANNEXURE_R2_PREFIX}/invoice_pdf_${opts.invoiceId}_${opts.clientId}.pdf`;
}

export function buildServiceInvoiceInvoicePdfFilename(opts: {
  invoiceId: number;
  clientId: number;
}): string {
  return `invoice_pdf_${opts.invoiceId}_${opts.clientId}.pdf`;
}

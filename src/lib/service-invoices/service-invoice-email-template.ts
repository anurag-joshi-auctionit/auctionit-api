/**
 * Legacy service-invoice customer email (ServiceInvoiceEmailBodyFormat.html +
 * usp_ServiceInvoice @Param='EMAIL' subject).
 */

import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate, formatMonthYearShort } from "@auctionit/lib/date";

/**
 * Optional CC/BCC for this template only. Set manually when needed
 * (comma-separated). Leave null/empty when unused.
 */
// export const SERVICE_INVOICE_EMAIL_CC: string | null = "invoicing@auctionit.in";
export const SERVICE_INVOICE_EMAIL_CC: string | null = null;
export const SERVICE_INVOICE_EMAIL_BCC: string | null = null;

export type ServiceInvoiceEmailVars = {
  billingName: string;
  invoiceNumber: string;
  /** App-wide date display, e.g. `12 Aug 2026`. */
  invoiceDate: string;
  /** App-wide currency display, e.g. `₹1,234.00`. */
  amount: string;
  /** App-wide month/year, e.g. `Aug 2026`. */
  invoiceMonthYear: string;
  companyName: string;
  plantLocationName: string;
  /** When false (fixed-fee invoices), body omits “along with detail”. */
  includeAnnexureDetail?: boolean;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @deprecated Prefer `formatDate` from `@auctionit/lib/date`. */
export const formatServiceInvoiceEmailDate = formatDate;

/** @deprecated Prefer `formatMonthYearShort` from `@auctionit/lib/date`. */
export const formatServiceInvoiceMonthYear = formatMonthYearShort;

/** @deprecated Prefer `formatCurrency(value, { fractionDigits: 2 })`. */
export function formatServiceInvoiceEmailAmount(
  value: number | string | null | undefined,
): string {
  return formatCurrency(value, { fractionDigits: 2 });
}

/**
 * SP subject:
 * `Invoice for the month of {MMM yyyy}- {Company},{Plant} `
 */
export function buildServiceInvoiceEmailSubject(
  vars: Pick<
    ServiceInvoiceEmailVars,
    "invoiceMonthYear" | "companyName" | "plantLocationName"
  >,
): string {
  return `Invoice for the month of ${vars.invoiceMonthYear} - ${vars.companyName}, ${vars.plantLocationName}`;
}

/** Legacy ServiceInvoiceEmailBodyFormat.html with placeholder substitution. */
export function buildServiceInvoiceEmailHtml(
  vars: ServiceInvoiceEmailVars,
): string {
  const billingName = escapeHtml(vars.billingName.trim() || "Sir/Madam");
  const orderId = escapeHtml(vars.invoiceNumber);
  const invoiceDate = escapeHtml(vars.invoiceDate);
  const amount = escapeHtml(vars.amount);
  const invoiceMonthYear = escapeHtml(vars.invoiceMonthYear);
  const withDetail =
    vars.includeAnnexureDetail === false ? "" : " along with detail";

  return `<html>
<body>
Dear ${billingName},
<br><br> 
We are enclosing our Invoice No. ${orderId} Dt. ${invoiceDate} of ${amount} for the services rendered in ${invoiceMonthYear}${withDetail}.
<br><br>
<strong font-size="11px">Note</strong>: iCom Analytics Limited is registered under MSMED Act, 2006 as Micro Enterprise vide registration number DL-II-0035885. Please ensure making payment on or before due date as prescribed under the said Act.
<br><br>
You are requested to process the same and release the payment at the earliest.
<br><br>
Regards,
<br>
Team AuctionIt
</body>
</html>`;
}

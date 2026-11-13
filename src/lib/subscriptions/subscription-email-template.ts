/**
 * Legacy subscription invoice email (EMDController GeneratePdfInvoice Flag=EMAIL).
 */

import { formatCurrency } from "@auctionit/lib/currency";
import { formatDate } from "@auctionit/lib/date";

// export const SUBSCRIPTION_INVOICE_EMAIL_CC: string | null =
// "invoicing@auctionit.in";
export const SUBSCRIPTION_INVOICE_EMAIL_CC: string | null = null;
export const SUBSCRIPTION_INVOICE_EMAIL_BCC: string | null = null;

export type SubscriptionEmailVars = {
  invoiceNumber: string;
  /** App-wide date display, e.g. `12 Aug 2026`. */
  invoiceDate: string;
  /** App-wide currency display, e.g. `₹1,180.00`. */
  amount: string;
  subscriptionTypeName: string;
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
export const formatSubscriptionEmailDate = formatDate;

/** @deprecated Prefer `formatCurrency(value, { fractionDigits: 2 })`. */
export function formatSubscriptionEmailAmount(
  value: number | string | null | undefined,
): string {
  return formatCurrency(value, { fractionDigits: 2 });
}

export function buildSubscriptionEmailSubject(): string {
  return "Your Subscription Invoice";
}

/** Legacy EMDController inline body for subscription invoice email. */
export function buildSubscriptionEmailHtml(
  vars: SubscriptionEmailVars,
): string {
  const invoiceNumber = escapeHtml(vars.invoiceNumber);
  const invoiceDate = escapeHtml(vars.invoiceDate);
  const amount = escapeHtml(vars.amount);
  const subscriptionTypeName = escapeHtml(vars.subscriptionTypeName);

  return `<html>
<body>
Dear Sir/Madam,
<br><br>
Please find attached the Invoice no.${invoiceNumber} dated ${invoiceDate} for ${amount} (Inclusive of GST) towards online bidding subscription for the period ${subscriptionTypeName}
<br><br>
Regards,
<br>
Team AuctionIt
</body>
</html>`;
}

/**
 * Admin-triggered Instamojo subscription payment link email.
 */

import { formatCurrency } from "@auctionit/lib/currency";

export const SUBSCRIPTION_PAYMENT_LINK_EMAIL_CC: string | null = null;
export const SUBSCRIPTION_PAYMENT_LINK_EMAIL_BCC: string | null = null;

export type SubscriptionPaymentLinkEmailVars = {
  companyName: string;
  planName: string;
  /** App-wide currency display, e.g. `₹1,180.00`. */
  amount: string;
  paymentUrl: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatSubscriptionPaymentLinkEmailAmount(
  value: number | string | null | undefined,
): string {
  return formatCurrency(value, { fractionDigits: 2 });
}

export function buildSubscriptionPaymentLinkEmailSubject(): string {
  return "Your AuctionIt Subscription Payment Link";
}

export function buildSubscriptionPaymentLinkEmailHtml(
  vars: SubscriptionPaymentLinkEmailVars,
): string {
  const companyName = escapeHtml(vars.companyName);
  const planName = escapeHtml(vars.planName);
  const amount = escapeHtml(vars.amount);
  const paymentUrl = escapeHtml(vars.paymentUrl);

  return `<html>
<body>
Dear Sir/Madam,
<br><br>
Please use the secure payment link below to pay ${amount} (Inclusive of GST)
towards online bidding subscription (${planName}) for ${companyName}.
<br><br>
<a href="${paymentUrl}">Pay Subscription Now</a>
<br><br>
Or copy and paste this link into your browser:<br>
${paymentUrl}
<br><br>
If you have already paid, you may ignore this email.
<br><br>
Regards,
<br>
Team AuctionIt
</body>
</html>`;
}

export const SUBSCRIPTION_INVOICE_R2_PREFIX = "subscriptions";
export const SUBSCRIPTION_PDF_CONTENT_TYPE = "application/pdf";
export const SUBSCRIPTION_PDF_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * R2 object key (stable 1:1 per subscription + bidder).
 * Pattern: `subscriptions/subscription-{subscriptionId}-{bidderId}.pdf`
 */
export function buildSubscriptionInvoicePdfS3Key(opts: {
  subscriptionId: number;
  bidderId: number;
}): string {
  return `${SUBSCRIPTION_INVOICE_R2_PREFIX}/subscription-${opts.subscriptionId}-${opts.bidderId}.pdf`;
}

export function buildSubscriptionInvoicePdfFilename(opts: {
  subscriptionId: number;
  bidderId: number;
}): string {
  return `subscription-${opts.subscriptionId}-${opts.bidderId}.pdf`;
}

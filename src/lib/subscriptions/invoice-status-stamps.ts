import {
  subscriptions,
  type SubscriptionInvoiceStatus,
} from "../../db/schema/subscriptions.js";

export function invoiceStatusStampFields(
  status: SubscriptionInvoiceStatus,
  now: string,
  userId: number | null,
): Partial<typeof subscriptions.$inferInsert> {
  switch (status) {
    case "requested":
      return {
        invoiceRequestedAt: now,
        invoiceRequestedBy: userId,
      };
    case "generated":
      return {
        invoiceGeneratedAt: now,
        invoiceGeneratedBy: userId,
      };
    case "recheck":
      return {
        invoiceRecheckedAt: now,
        invoiceRecheckedBy: userId,
      };
    case "cancelled":
      return {
        invoiceCancelledAt: now,
        invoiceCancelledBy: userId,
      };
    default:
      return {};
  }
}

import {
  serviceInvoices,
  type ServiceInvoiceStatus,
} from "../../db/schema/service-invoices.js";

export function statusStampFields(
  status: ServiceInvoiceStatus,
  now: string,
  userId: number | null,
): Partial<typeof serviceInvoices.$inferInsert> {
  switch (status) {
    case "requested":
      return { requestedAt: now, requestedBy: userId };
    case "generated":
      return { generatedAt: now, generatedBy: userId };
    case "recheck":
      return { recheckedAt: now, recheckedBy: userId };
    case "cancelled":
      return { cancelledAt: now, cancelledBy: userId };
    case "draft":
    default:
      return {};
  }
}

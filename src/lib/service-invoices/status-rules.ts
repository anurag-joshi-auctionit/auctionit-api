import type { ServiceInvoiceStatus } from "../../db/schema/service-invoices.js";

/** Statuses where accounts may edit invoice number/date. */
export const ACCOUNTS_FIELD_EDITABLE_STATUSES = new Set<ServiceInvoiceStatus>([
  "requested",
]);

/** Statuses where accounts may upload or replace annexure/invoice PDFs. */
export const ACCOUNTS_PDF_UPLOAD_STATUSES = new Set<ServiceInvoiceStatus>([
  "requested",
  "generated",
]);

/**
 * Allowed accounts status transitions.
 * Admin returns recheck → requested (via patch status), so accounts can loop.
 */
export const ACCOUNTS_STATUS_TRANSITIONS: Record<
  ServiceInvoiceStatus,
  ReadonlySet<ServiceInvoiceStatus>
> = {
  draft: new Set(),
  requested: new Set(["recheck", "generated"]),
  recheck: new Set(),
  generated: new Set(["cancelled"]),
  cancelled: new Set(),
};

export function canAccountsTransition(
  from: ServiceInvoiceStatus,
  to: ServiceInvoiceStatus,
): boolean {
  return ACCOUNTS_STATUS_TRANSITIONS[from].has(to);
}

export function isAdminEditableStatus(status: ServiceInvoiceStatus): boolean {
  return status === "draft" || status === "recheck";
}

/** Cancelled invoices are fully locked — no edits, downloads, or file URLs. */
export function isCancelledStatus(status: ServiceInvoiceStatus): boolean {
  return status === "cancelled";
}

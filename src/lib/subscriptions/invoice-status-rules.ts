import type { SubscriptionInvoiceStatus } from "../../db/schema/subscriptions.js";

/**
 * Allowed accounts status transitions via PATCH /accounts.
 * Upload PDF still performs requested → generated separately.
 */
export const ACCOUNTS_INVOICE_STATUS_TRANSITIONS: Record<
  SubscriptionInvoiceStatus,
  ReadonlySet<SubscriptionInvoiceStatus>
> = {
  requested: new Set(["recheck", "cancelled"]),
  recheck: new Set(["cancelled"]),
  generated: new Set(["cancelled"]),
  cancelled: new Set(),
};

/** Admin may return recheck → requested so accounts can upload again. */
export const ADMIN_INVOICE_STATUS_TRANSITIONS: Record<
  SubscriptionInvoiceStatus,
  ReadonlySet<SubscriptionInvoiceStatus>
> = {
  requested: new Set(),
  recheck: new Set(["requested"]),
  generated: new Set(),
  cancelled: new Set(),
};

export function canAccountsInvoiceTransition(
  from: SubscriptionInvoiceStatus,
  to: SubscriptionInvoiceStatus,
): boolean {
  return ACCOUNTS_INVOICE_STATUS_TRANSITIONS[from].has(to);
}

export function canAdminInvoiceTransition(
  from: SubscriptionInvoiceStatus,
  to: SubscriptionInvoiceStatus,
): boolean {
  return ADMIN_INVOICE_STATUS_TRANSITIONS[from].has(to);
}

export function isAccountsUploadAllowed(
  status: SubscriptionInvoiceStatus,
): boolean {
  return status === "requested" || status === "generated";
}

/** Statuses where admin may edit payment fields and re-request. */
export function isAdminEditableStatus(
  status: SubscriptionInvoiceStatus,
): boolean {
  return status === "recheck";
}

export function isCancelledInvoiceStatus(
  status: SubscriptionInvoiceStatus,
): boolean {
  return status === "cancelled";
}

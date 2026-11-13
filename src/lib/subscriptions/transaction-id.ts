/** Normalize for uniqueness: trim, strip all whitespace, lowercase. */
export function normalizeSubscriptionTransactionId(value: string): string {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

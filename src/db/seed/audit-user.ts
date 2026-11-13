/** Default actor for seed rows when created_by / updated_by is missing or orphaned. */
export const SEED_DEFAULT_USER_ID = 1;

/**
 * Resolve an audit user id for seeding.
 * Prefer a raw id that exists in `validUserIds`; otherwise fall back to user 1.
 * Call only when the matching timestamp (created_at / updated_at) is present.
 */
export function resolveAuditUserId(
  raw: number | null | undefined,
  validUserIds: Set<number>,
): number {
  return raw != null && validUserIds.has(raw) ? raw : SEED_DEFAULT_USER_ID;
}

/**
 * Like resolveAuditUserId, but returns null when the timestamp is absent.
 */
export function resolveAuditUserIdIfTimestamp(
  timestamp: unknown,
  raw: number | null | undefined,
  validUserIds: Set<number>,
): number | null {
  if (timestamp == null) return null;
  return resolveAuditUserId(raw, validUserIds);
}

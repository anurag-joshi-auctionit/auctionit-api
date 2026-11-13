import { and, eq } from "drizzle-orm";
import {
  ADMIN_GOVERNANCE_KEYS,
  type PermissionKey,
} from "@auctionit/authz";
import { AuthzErrorMessages } from "@auctionit/messages/authz";
import { db } from "../db/index.js";
import { permissions, rolePermissions } from "../db/schema/permissions.js";
import type { AuthUser } from "../services/auth.service.js";

export type AuthzUser = AuthUser & {
  permissions: string[];
};

export function isAdminUser(user: Pick<AuthUser, "role">): boolean {
  return user.role.isAdmin;
}

export function isOwnerUser(user: Pick<AuthUser, "isOwner">): boolean {
  return Boolean(user.isOwner);
}

/**
 * Enabled keys from the role's matrix. Admin roles use the matrix too;
 * `isAdmin` only adds the roles/permissions governance keys so an admin can
 * never lock themselves out of the matrix.
 */
export async function loadEnabledPermissionKeys(
  roleId: number,
  isAdmin: boolean,
): Promise<string[]> {
  const rows = await db
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(
      and(eq(rolePermissions.roleId, roleId), eq(rolePermissions.enabled, true)),
    );
  const keys = rows.map((r) => r.key);
  if (!isAdmin) return keys;
  return [...new Set([...keys, ...ADMIN_GOVERNANCE_KEYS])];
}

export function hasPermission(
  user: AuthzUser,
  key: PermissionKey | string,
): boolean {
  return user.permissions.includes(key);
}

export function hasAnyPermission(
  user: AuthzUser,
  keys: readonly (PermissionKey | string)[],
): boolean {
  return keys.some((k) => user.permissions.includes(k));
}

export class ForbiddenError extends Error {
  constructor(message: string = AuthzErrorMessages.FORBIDDEN) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function authorize(
  user: AuthzUser,
  key: PermissionKey | string,
): void {
  if (!hasPermission(user, key)) {
    throw new ForbiddenError(AuthzErrorMessages.FORBIDDEN);
  }
}

export function authorizeAny(
  user: AuthzUser,
  keys: readonly (PermissionKey | string)[],
): void {
  if (!hasAnyPermission(user, keys)) {
    throw new ForbiddenError(AuthzErrorMessages.FORBIDDEN);
  }
}

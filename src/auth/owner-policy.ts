import { eq } from "drizzle-orm";
import { AuthzErrorMessages } from "@auctionit/messages/authz";
import { db } from "../db/index.js";
import { roles } from "../db/schema/roles.js";
import { users } from "../db/schema/users.js";
import {
  ForbiddenError,
  isAdminUser,
  isOwnerUser,
  type AuthzUser,
} from "./permissions.js";

export async function loadRoleById(roleId: number) {
  const [row] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  return row ?? null;
}

/** Only the owner can grant or revoke is_owner. */
export function assertCanSetOwner(actor: AuthzUser, nextIsOwner: boolean): void {
  if (nextIsOwner && !isOwnerUser(actor)) {
    throw new ForbiddenError(AuthzErrorMessages.OWNER_GRANT_ONLY);
  }
  if (!nextIsOwner && !isOwnerUser(actor)) {
    throw new ForbiddenError(AuthzErrorMessages.OWNER_REVOKE_ONLY);
  }
}

export async function assertOwnerInvariant(
  roleId: number,
  isOwner: boolean,
): Promise<void> {
  if (!isOwner) return;
  const role = await loadRoleById(roleId);
  if (!role?.isAdmin) {
    throw new ForbiddenError(AuthzErrorMessages.OWNER_REQUIRES_ADMIN);
  }
}

/** Admin or owner may manage roles/permissions masters. */
export function assertCanAccessRolesMasters(actor: AuthzUser): void {
  if (isOwnerUser(actor) || isAdminUser(actor)) return;
  throw new ForbiddenError(AuthzErrorMessages.ADMIN_ONLY);
}

export async function assertCanManageUser(
  actor: AuthzUser,
  targetUserId: number,
): Promise<void> {
  if (isOwnerUser(actor)) return;

  const [target] = await db
    .select({
      isOwner: users.isOwner,
      isAdmin: roles.isAdmin,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!target) {
    throw new ForbiddenError(AuthzErrorMessages.USER_NOT_FOUND);
  }
  if (target.isOwner) {
    throw new ForbiddenError(AuthzErrorMessages.OWNER_MANAGE_ONLY);
  }
}

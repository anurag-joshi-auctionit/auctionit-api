import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import {
  ADMIN_EXCLUDED_DEFAULT_KEYS,
  ADMIN_GOVERNANCE_KEYS,
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  type PermissionKey,
} from "@auctionit/authz";
import {
  RolesErrorMessages,
  RolesValidationMessages,
} from "@auctionit/messages/roles";
import { PermissionsValidationMessages } from "@auctionit/messages/permissions";
import { db } from "../db/index.js";
import { permissions, rolePermissions } from "../db/schema/permissions.js";
import { roles } from "../db/schema/roles.js";
import { ROLE_CODE_RE } from "../lib/roles/schemas.js";
import { formatUtcNow } from "@auctionit/lib/date";

export class RolesServiceError extends Error {
  constructor(
    public code: "not_found" | "conflict" | "validation",
    message: string,
  ) {
    super(message);
    this.name = "RolesServiceError";
  }
}

/** Default `enabled` for a new matrix row: admin roles get everything except Accounts/HOD stages. */
function defaultEnabled(isAdmin: boolean, key: string): boolean {
  return (
    isAdmin &&
    !(ADMIN_EXCLUDED_DEFAULT_KEYS as readonly string[]).includes(key)
  );
}

function isGovernanceKey(key: string): boolean {
  return (ADMIN_GOVERNANCE_KEYS as readonly string[]).includes(key);
}

function slugifyRoleCode(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export class RolesService {
  async list() {
    return db
      .select({
        id: roles.id,
        code: roles.code,
        name: roles.name,
        description: roles.description,
        isAdmin: roles.isAdmin,
        createdAt: roles.createdAt,
      })
      .from(roles)
      .orderBy(asc(roles.name));
  }

  async getById(id: number) {
    const [row] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
    return row ?? null;
  }

  async getByCode(code: string) {
    const [row] = await db
      .select()
      .from(roles)
      .where(eq(roles.code, code))
      .limit(1);
    return row ?? null;
  }

  async create(input: {
    code: string;
    name: string;
    description?: string;
    isAdmin?: boolean;
  }, userId?: number) {
    const code = slugifyRoleCode(input.code);
    if (!code) {
      throw new RolesServiceError(
        "validation",
        RolesValidationMessages.CODE_REQUIRED,
      );
    }
    if (!ROLE_CODE_RE.test(code)) {
      throw new RolesServiceError(
        "validation",
        RolesValidationMessages.CODE_INVALID,
      );
    }
    const existing = await this.getByCode(code);
    if (existing) {
      throw new RolesServiceError(
        "conflict",
        RolesValidationMessages.CODE_EXISTS,
      );
    }

    const now = formatUtcNow();
    const [created] = await db
      .insert(roles)
      .values({
        code,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        isAdmin: Boolean(input.isAdmin),
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) {
      throw new RolesServiceError(
        "validation",
        RolesErrorMessages.CREATE_FAILED,
      );
    }

    // Seed matrix rows for all catalog permissions (admin defaults or disabled)
    const allPerms = await db
      .select({ id: permissions.id, key: permissions.key })
      .from(permissions);
    if (allPerms.length > 0) {
      await db.insert(rolePermissions).values(
        allPerms.map((p) => ({
          roleId: created.id,
          permissionId: p.id,
          enabled: defaultEnabled(created.isAdmin, p.key),
          updatedAt: now,
          updatedBy: userId ?? null,
        })),
      );
    }

    return created;
  }

  async update(
    id: number,
    input: {
      name?: string;
      description?: string | null;
      isAdmin?: boolean;
    },
    userId?: number,
  ) {
    const existing = await this.getById(id);
    if (!existing) {
      throw new RolesServiceError(
        "not_found",
        RolesErrorMessages.ROLE_NOT_FOUND,
      );
    }

    const [updated] = await db
      .update(roles)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined
          ? { description: input.description?.trim() || null }
          : {}),
        ...(input.isAdmin !== undefined ? { isAdmin: input.isAdmin } : {}),
        updatedAt: formatUtcNow(),
        updatedBy: userId ?? null,
      })
      .where(eq(roles.id, id))
      .returning();

    return updated!;
  }

  async listPermissionsCatalog() {
    return db.select().from(permissions).orderBy(asc(permissions.key));
  }

  async getRolePermissions(roleId: number) {
    const role = await this.getById(roleId);
    if (!role) {
      throw new RolesServiceError(
        "not_found",
        RolesErrorMessages.ROLE_NOT_FOUND,
      );
    }

    const catalogOrder = new Map(
      PERMISSION_CATALOG.map((entry, index) => [entry.key, index]),
    );

    const rows = await db
      .select({
        permissionId: permissions.id,
        key: permissions.key,
        label: permissions.label,
        description: permissions.description,
        group: permissions.group,
        enabled: rolePermissions.enabled,
      })
      .from(permissions)
      .leftJoin(
        rolePermissions,
        and(
          eq(rolePermissions.permissionId, permissions.id),
          eq(rolePermissions.roleId, roleId),
        ),
      );

    const sorted = rows
      .map((r) => ({
        ...r,
        // Governance keys are always effective for admin roles.
        enabled:
          Boolean(r.enabled) || (role.isAdmin && isGovernanceKey(r.key)),
      }))
      .sort(
        (a, b) =>
          (catalogOrder.get(a.key as PermissionKey) ?? Number.MAX_SAFE_INTEGER) -
          (catalogOrder.get(b.key as PermissionKey) ?? Number.MAX_SAFE_INTEGER),
      );

    return {
      role,
      permissions: sorted,
    };
  }

  async setRolePermissions(
    roleId: number,
    updates: { key: string; enabled: boolean }[],
    userId?: number,
  ) {
    const role = await this.getById(roleId);
    if (!role) {
      throw new RolesServiceError(
        "not_found",
        RolesErrorMessages.ROLE_NOT_FOUND,
      );
    }
    if (
      role.isAdmin &&
      updates.some((u) => !u.enabled && isGovernanceKey(u.key))
    ) {
      throw new RolesServiceError(
        "validation",
        PermissionsValidationMessages.ADMIN_GOVERNANCE_LOCKED,
      );
    }

    const keys = updates.map((u) => u.key);
    const permRows = await db
      .select({ id: permissions.id, key: permissions.key })
      .from(permissions)
      .where(inArray(permissions.key, keys));

    const byKey = new Map(permRows.map((p) => [p.key, p.id]));
    const now = formatUtcNow();

    for (const u of updates) {
      const permissionId = byKey.get(u.key);
      if (permissionId === undefined) continue;
      await db
        .insert(rolePermissions)
        .values({
          roleId,
          permissionId,
          enabled: u.enabled,
          updatedAt: now,
          updatedBy: userId ?? null,
        })
        .onConflictDoUpdate({
          target: [rolePermissions.roleId, rolePermissions.permissionId],
          set: {
            enabled: u.enabled,
            updatedAt: now,
            updatedBy: userId ?? null,
          },
        });
    }

    return this.getRolePermissions(roleId);
  }
}

export const rolesService = new RolesService();

/** Old key → new key, renamed in place so existing role grants carry over. */
const PERMISSION_KEY_RENAMES: readonly [string, string][] = [
  ["emd.passbook.read", "emd.transactions.read"],
  ["bidder.emd.write", "emd.credits.write"],
  ["emd.report.read", "emd.reports.read"],
  ["emd.refunds.decide", "emd.refunds.review"],
  ["emd.refunds.approve", "emd.refunds.review"],
  ["emd.refunds.accounts-approve", "emd.refunds.verify"],
  ["emd.refunds.process", "emd.refunds.pay"],
  ["emd.forfeitures.approve", "emd.forfeitures.review"],
  ["emd.forfeitures.pay-client", "emd.forfeitures.pay"],
];

/** Upsert catalog from code; never flips existing enabled flags. */
export async function bootstrapPermissionCatalog(): Promise<void> {
  const now = formatUtcNow();
  // Rename in place so existing role grants stay attached to the same row.
  const already = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.key, "module.portal-client-dashboard"))
    .limit(1);
  if (already.length === 0) {
    await db
      .update(permissions)
      .set({
        key: "module.portal-client-dashboard",
        label: "Client portal dashboard",
        description: "External portal client dashboard",
        updatedAt: now,
      })
      .where(eq(permissions.key, "module.portal-client-overview"));
  }
  const liveAuctionsAlready = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.key, "auction.live.auctions"))
    .limit(1);
  if (liveAuctionsAlready.length === 0) {
    await db
      .update(permissions)
      .set({
        key: "auction.live.auctions",
        label: "Live auctions",
        description: "View live auctions",
        updatedAt: now,
      })
      .where(eq(permissions.key, "auction.live.monitor"));
  }
  for (const [from, to] of PERMISSION_KEY_RENAMES) {
    const [target] = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(eq(permissions.key, to))
      .limit(1);
    if (target) continue;
    await db
      .update(permissions)
      .set({ key: to, updatedAt: now })
      .where(eq(permissions.key, from));
  }
  for (const entry of PERMISSION_CATALOG) {
    await db
      .insert(permissions)
      .values({
        key: entry.key,
        label: entry.label,
        description: entry.description,
        group: entry.group,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: permissions.key,
        set: {
          label: entry.label,
          description: entry.description,
          group: entry.group,
          updatedAt: now,
        },
      });
  }

  // Ensure every role has a row for every permission. New rows are disabled,
  // except on admin roles, which get every key but the Accounts/HOD stages.
  const allRoles = await db
    .select({ id: roles.id, isAdmin: roles.isAdmin })
    .from(roles);
  const allPerms = await db
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions);
  if (allRoles.length === 0 || allPerms.length === 0) return;

  for (const role of allRoles) {
    for (const perm of allPerms) {
      await db
        .insert(rolePermissions)
        .values({
          roleId: role.id,
          permissionId: perm.id,
          enabled: defaultEnabled(role.isAdmin, perm.key),
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
  }

  // Drop stale permission keys no longer in catalog
  const catalogKeys = [...PERMISSION_KEYS];
  if (catalogKeys.length > 0) {
    await db
      .delete(permissions)
      .where(notInArray(permissions.key, catalogKeys));
  }
}

export type { PermissionKey };

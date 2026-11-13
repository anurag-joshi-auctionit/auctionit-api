import { z } from "../zod.js";

// Mirrors rolesService.list / create / update / getRolePermissions in
// services/roles.service.ts (rows of db/schema/roles.ts and permissions.ts).

export const RoleListItem = z
  .object({
    id: z.number().int(),
    code: z.string().openapi({ example: "client_limited" }),
    name: z.string(),
    description: z.string().nullable(),
    isAdmin: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("RoleListItem");

export const RoleList = z.object({ items: z.array(RoleListItem) }).openapi("RoleList");

/** Full `roles` row as returned by `.returning()` / `select()`. */
export const Role = z
  .object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isAdmin: z.boolean().openapi({ description: "When true the role can always manage roles and permissions. Feature access still comes from the permission matrix." }),
    createdAt: z.string(),
    createdBy: z.number().int().nullable(),
    updatedAt: z.string().nullable(),
    updatedBy: z.number().int().nullable(),
  })
  .openapi("Role");

export const RoleEnvelope = z.object({ role: Role }).openapi("RoleEnvelope");

export const RolePermissionRow = z
  .object({
    permissionId: z.number().int(),
    key: z.string().openapi({ example: "clients.read" }),
    label: z.string(),
    description: z.string(),
    group: z.string(),
    enabled: z.boolean(),
  })
  .openapi("RolePermissionRow");

export const RolePermissions = z
  .object({
    role: Role,
    permissions: z
      .array(RolePermissionRow)
      .openapi({ description: "Every catalog permission, in catalog order, with this role's flag." }),
  })
  .openapi("RolePermissions");

/** `{ error, code }` from RolesServiceError handlers. */
export const RoleErrorBody = z
  .object({ error: z.string(), code: z.enum(["not_found", "conflict", "validation"]) })
  .openapi("RoleErrorBody");

import { z } from "zod";
import {
  createRoleSchema,
  patchRoleSchema,
  putRolePermissionsSchema,
} from "../../lib/roles/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  RoleEnvelope,
  RoleErrorBody,
  RoleList,
  RolePermissions,
} from "../responses/roles.js";

// Docs for src/routes/roles.ts — see docs/api/README.md.
const r = documentRouter("/roles");

const badIdOrBody = {
  description: "Invalid role id, or body validation failed.",
  schema: z.union([ValidationErrorBody, ErrorBody]),
};

r.get("/", {
  summary: "List roles",
  description: "All roles, ordered by name.",
  responses: { 200: RoleList },
});

r.post("/", {
  summary: "Create role",
  description:
    "Creates a role. `code` is normalised to lowercase snake_case. The new role gets a disabled row for every " +
    "catalog permission (an `isAdmin` role gets every key enabled except the Accounts/HOD EMD stage actions); " +
    "change them with `PUT /roles/{id}/permissions`.",
  body: createRoleSchema,
  responses: {
    201: { description: "Created role.", schema: RoleEnvelope },
    400: { description: "Validation error (including an invalid normalised `code`).", schema: ValidationErrorBody },
    409: { description: "A role with this `code` already exists (`fieldErrors.code`).", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update role",
  description:
    "Partial update of name, description (`null` clears it) and the `isAdmin` flag. The code cannot be changed. " +
    "Changing `isAdmin` does not change the role's permission matrix.",
  params: IdParam,
  body: patchRoleSchema,
  responses: {
    200: RoleEnvelope,
    400: badIdOrBody,
    404: { description: "Role not found.", schema: RoleErrorBody },
  },
});

r.get("/:id/permissions", {
  summary: "Get role permission matrix",
  params: IdParam,
  responses: {
    200: RolePermissions,
    400: { description: "Invalid role id.", schema: ErrorBody },
    404: { description: "Role not found.", schema: RoleErrorBody },
  },
});

r.put("/:id/permissions", {
  summary: "Set role permissions",
  description:
    "Upserts the enabled flag for each listed permission key; keys not in the catalog are ignored silently and " +
    "unlisted keys keep their current value. On an admin role (`isAdmin`) the roles/permissions governance keys " +
    "cannot be disabled. Returns the full matrix.",
  params: IdParam,
  body: putRolePermissionsSchema,
  responses: {
    200: RolePermissions,
    400: {
      description: "Invalid role id, validation error, or an attempt to disable a governance key on an admin role (`code: validation`).",
      schema: z.union([ValidationErrorBody, ErrorBody, RoleErrorBody]),
    },
    404: { description: "Role not found.", schema: RoleErrorBody },
  },
});

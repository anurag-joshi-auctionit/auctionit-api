import { z } from "zod";
import { RolesValidationMessages } from "@auctionit/messages/roles";
import { PermissionsValidationMessages } from "@auctionit/messages/permissions";

/** Lowercase snake_case: `admin`, `client_limited`. */
export const ROLE_CODE_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const roleCodeSchema = z
  .string({ required_error: RolesValidationMessages.CODE_REQUIRED })
  .trim()
  .min(1, RolesValidationMessages.CODE_REQUIRED)
  .max(64, RolesValidationMessages.CODE_TOO_LONG)
  .regex(ROLE_CODE_RE, RolesValidationMessages.CODE_INVALID);

const optionalDescription = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .trim()
    .max(500, RolesValidationMessages.DESCRIPTION_TOO_LONG)
    .optional(),
);

export const createRoleSchema = z.object({
  code: roleCodeSchema,
  name: z
    .string()
    .trim()
    .min(1, RolesValidationMessages.NAME_REQUIRED)
    .max(100, RolesValidationMessages.NAME_TOO_LONG),
  description: optionalDescription,
  isAdmin: z.boolean().optional(),
});

export const patchRoleSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, RolesValidationMessages.NAME_REQUIRED)
    .max(100, RolesValidationMessages.NAME_TOO_LONG)
    .optional(),
  description: z
    .string()
    .trim()
    .max(500, RolesValidationMessages.DESCRIPTION_TOO_LONG)
    .nullable()
    .optional(),
  isAdmin: z.boolean().optional(),
});

export const putRolePermissionsSchema = z.object({
  permissions: z
    .array(
      z.object({
        key: z.string().min(1),
        enabled: z.boolean(),
      }),
    )
    .min(1, PermissionsValidationMessages.PERMISSIONS_REQUIRED),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type PatchRoleInput = z.infer<typeof patchRoleSchema>;
export type PutRolePermissionsInput = z.infer<typeof putRolePermissionsSchema>;

import { UsersValidationMessages } from "@auctionit/messages/users";
import { z } from "zod";
import {
  nullableIndianPhoneSchema,
  requiredEmailSchema,
  requiredIndianPhoneSchema,
} from "../validation/normalized-string.js";

/** Role code for admin SPA staff (validated against roles master on write). */
export const staffRoleSchema = z
  .string()
  .trim()
  .min(1, UsersValidationMessages.ROLE_REQUIRED)
  .max(64);

export const staffListQuerySchema = z.object({
  search: z.string().optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
  role: z.string().trim().optional(),
  clientId: z.coerce.number().int().positive().optional(),
  bidderId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(["name", "lastLoginAt", "createdAt"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

const nullableStr = (max: number) =>
  z
    .union([z.string().trim().max(max), z.literal("")])
    .nullish()
    .transform((v): string | null | undefined => (v === "" ? null : v));

const nullableStaffPhone = nullableIndianPhoneSchema(
  UsersValidationMessages.INVALID_PHONE,
);

const requiredStaffEmail = requiredEmailSchema(
  UsersValidationMessages.EMAIL_REQUIRED,
  UsersValidationMessages.INVALID_EMAIL,
);

const requiredStaffPhone = requiredIndianPhoneSchema(
  UsersValidationMessages.PHONE_REQUIRED,
  UsersValidationMessages.INVALID_PHONE,
);

const userLoginNameSchema = z
  .string()
  .trim()
  .min(1, UsersValidationMessages.USERNAME_REQUIRED)
  .max(50);

export const createStaffUserSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, UsersValidationMessages.NAME_REQUIRED)
    .max(100),
  userLoginName: userLoginNameSchema,
  emailId: requiredStaffEmail,
  phoneNumber: requiredStaffPhone,
  whatsappNumber: nullableStaffPhone,
  designation: nullableStr(100),
  role: staffRoleSchema,
  isActive: z.boolean().default(true),
  bidderId: z.number().int().positive().nullish(),
  clientIds: z.array(z.number().int().positive()).nullish(),
});

export const updateStaffUserSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, UsersValidationMessages.NAME_REQUIRED)
    .max(100),
  emailId: requiredStaffEmail,
  phoneNumber: requiredStaffPhone,
  whatsappNumber: nullableStaffPhone,
  designation: nullableStr(100),
  role: staffRoleSchema,
  bidderId: z.number().int().positive().nullish(),
  clientIds: z.array(z.number().int().positive()).nullish(),
});

export type StaffUserRole = z.infer<typeof staffRoleSchema>;
export type StaffListQuery = z.infer<typeof staffListQuerySchema>;
export type CreateStaffUserInput = z.infer<typeof createStaffUserSchema>;
export type UpdateStaffUserInput = z.infer<typeof updateStaffUserSchema>;

// Bidder / client portal login accounts (nested under /bidders/:id/users, etc.)
const requiredEntityEmail = requiredEmailSchema(
  UsersValidationMessages.EMAIL_REQUIRED,
  UsersValidationMessages.INVALID_EMAIL,
);

const requiredEntityPhone = requiredIndianPhoneSchema(
  UsersValidationMessages.PHONE_REQUIRED,
  UsersValidationMessages.INVALID_PHONE,
);

const nullableEntityPhone = nullableIndianPhoneSchema(
  UsersValidationMessages.INVALID_PHONE,
);

export const entityUsersListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  isActive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  sortBy: z.enum(["name", "lastLoginAt"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type EntityUsersListParams = z.infer<typeof entityUsersListQuerySchema>;

export const createEntityUserSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, UsersValidationMessages.NAME_REQUIRED)
    .max(100),
  userLoginName: userLoginNameSchema,
  emailId: requiredEntityEmail,
  phoneNumber: requiredEntityPhone,
  whatsappNumber: nullableEntityPhone,
  designation: nullableStr(100),
  isActive: z.boolean().optional(),
});

export const updateEntityUserSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, UsersValidationMessages.NAME_REQUIRED)
    .max(100),
  emailId: requiredEntityEmail,
  phoneNumber: requiredEntityPhone,
  whatsappNumber: nullableEntityPhone,
  designation: nullableStr(100),
  isActive: z.boolean(),
});

export type CreateEntityUserBody = z.infer<typeof createEntityUserSchema>;
export type UpdateEntityUserBody = z.infer<typeof updateEntityUserSchema>;

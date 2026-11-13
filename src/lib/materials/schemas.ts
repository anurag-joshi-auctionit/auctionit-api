import { CommonValidationMessages } from "@auctionit/messages/common";
import { z } from "zod";

export const createMaterialSchema = z.object({
  label: z.string().trim().min(1).max(200),
  parentId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  isActive: z.boolean().optional().default(true),
});

export const patchMaterialSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    parentId: z.number().int().positive().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.label !== undefined ||
      d.parentId !== undefined ||
      d.isActive !== undefined,
    { message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED },
  );

export type CreateMaterialInput = z.infer<typeof createMaterialSchema>;
export type PatchMaterialInput = z.infer<typeof patchMaterialSchema>;

export const MATERIAL_SORT_FIELDS = [
  "label",
  "depth",
  "isActive",
  "createdAt",
  "updatedAt",
] as const;

export const materialsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
  sortBy: z.enum(MATERIAL_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type MaterialsListParams = z.infer<typeof materialsListQuerySchema>;

export const materialsExportQuerySchema = materialsListQuerySchema.omit({
  page: true,
  pageSize: true,
});

export type MaterialsExportParams = z.infer<typeof materialsExportQuerySchema>;

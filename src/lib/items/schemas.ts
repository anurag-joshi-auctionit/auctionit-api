import { CommonValidationMessages } from "@auctionit/messages/common";
import { ItemsValidationMessages } from "@auctionit/messages/items";
import { z } from "zod";

const requiredString = (message: string) =>
  z
    .string({
      required_error: message,
      invalid_type_error: message,
    })
    .trim()
    .min(1, message);

export const ITEM_SORT_FIELDS = [
  "name",
  "clientName",
  "createdAt",
  "updatedAt",
  "itemId",
] as const;

export const itemsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  materialId: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(ITEM_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  dateField: z.enum(["createdAt", "updatedAt"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export type ItemsListParams = z.infer<typeof itemsListQuerySchema>;

export const itemsExportQuerySchema = itemsListQuerySchema.omit({
  page: true,
  pageSize: true,
});

export type ItemsExportParams = z.infer<typeof itemsExportQuerySchema>;

export const itemsStatsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
});

export type ItemsStatsParams = z.infer<typeof itemsStatsQuerySchema>;

export const createItemSchema = z.object({
  clientId: z
    .number({
      required_error: ItemsValidationMessages.CLIENT_REQUIRED,
      invalid_type_error: ItemsValidationMessages.CLIENT_REQUIRED,
    })
    .int()
    .positive(ItemsValidationMessages.CLIENT_REQUIRED),
  name: requiredString(ItemsValidationMessages.NAME_REQUIRED).max(
    1000,
    ItemsValidationMessages.NAME_MAX,
  ),
  materialId: z
    .number({
      required_error: ItemsValidationMessages.MATERIAL_REQUIRED,
      invalid_type_error: ItemsValidationMessages.MATERIAL_REQUIRED,
    })
    .int()
    .positive(ItemsValidationMessages.MATERIAL_REQUIRED),
  benchmarkMaterialId: z
    .number()
    .int()
    .positive(ItemsValidationMessages.BENCHMARK_MATERIAL_NOT_FOUND)
    .nullable()
    .optional(),
  isActive: z.boolean().optional().default(true),
});

export const patchItemSchema = z
  .object({
    name: requiredString(ItemsValidationMessages.NAME_REQUIRED)
      .max(1000, ItemsValidationMessages.NAME_MAX)
      .optional(),
    materialId: z
      .number({
        required_error: ItemsValidationMessages.MATERIAL_REQUIRED,
        invalid_type_error: ItemsValidationMessages.MATERIAL_REQUIRED,
      })
      .int()
      .positive(ItemsValidationMessages.MATERIAL_REQUIRED)
      .optional(),
    benchmarkMaterialId: z
      .number()
      .int()
      .positive(ItemsValidationMessages.BENCHMARK_MATERIAL_NOT_FOUND)
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.materialId !== undefined ||
      d.benchmarkMaterialId !== undefined ||
      d.isActive !== undefined,
    { message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED },
  );

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type PatchItemInput = z.infer<typeof patchItemSchema>;

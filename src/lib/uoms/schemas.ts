import { CommonValidationMessages } from "@auctionit/messages/common";
import { z } from "zod";
import { createMasterListQuerySchema } from "../masters/list-query.js";

const uomCodeSchema = z.string().trim().min(1).max(20);

export const UOM_SORT_FIELDS = ["id", "code", "isActive"] as const;

export const uomsListQuerySchema = createMasterListQuerySchema(UOM_SORT_FIELDS);

export type UomsListParams = z.infer<typeof uomsListQuerySchema>;

export const createUomSchema = z.object({
  code: uomCodeSchema,
  isActive: z.boolean().optional().default(true),
});

export const patchUomSchema = z
  .object({
    code: uomCodeSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => d.code !== undefined || d.isActive !== undefined, {
    message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED,
  });

export type CreateUomInput = z.infer<typeof createUomSchema>;
export type PatchUomInput = z.infer<typeof patchUomSchema>;

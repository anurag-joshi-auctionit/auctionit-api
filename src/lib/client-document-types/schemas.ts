import { CommonValidationMessages } from "@auctionit/messages/common";
import { z } from "zod";
import { documentTypesListQuerySchema } from "../masters/list-query.js";

export const clientDocumentTypesListQuerySchema = documentTypesListQuerySchema;

export type ClientDocumentTypesListParams = z.infer<
  typeof clientDocumentTypesListQuerySchema
>;

export const createClientDocumentTypeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isActive: z.boolean().optional().default(true),
});

export const patchClientDocumentTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.isActive !== undefined, {
    message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED,
  });

export type CreateClientDocumentTypeInput = z.infer<
  typeof createClientDocumentTypeSchema
>;
export type PatchClientDocumentTypeInput = z.infer<
  typeof patchClientDocumentTypeSchema
>;

import { CommonValidationMessages } from "@auctionit/messages/common";
import { z } from "zod";
import { documentTypesListQuerySchema } from "../masters/list-query.js";

export const bidderDocumentTypesListQuerySchema = documentTypesListQuerySchema;

export type BidderDocumentTypesListParams = z.infer<
  typeof bidderDocumentTypesListQuerySchema
>;

export const createBidderDocumentTypeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isActive: z.boolean().optional().default(true),
});

export const patchBidderDocumentTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.isActive !== undefined, {
    message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED,
  });

export type CreateBidderDocumentTypeInput = z.infer<
  typeof createBidderDocumentTypeSchema
>;
export type PatchBidderDocumentTypeInput = z.infer<
  typeof patchBidderDocumentTypeSchema
>;

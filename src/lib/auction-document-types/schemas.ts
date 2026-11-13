import { CommonValidationMessages } from "@auctionit/messages/common";
import { z } from "zod";
import { documentTypesListQuerySchema } from "../masters/list-query.js";

export const auctionDocumentTypesListQuerySchema = documentTypesListQuerySchema;

export type AuctionDocumentTypesListParams = z.infer<
  typeof auctionDocumentTypesListQuerySchema
>;

export const createAuctionDocumentTypeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isActive: z.boolean().optional().default(true),
});

export const patchAuctionDocumentTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.isActive !== undefined, {
    message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED,
  });

export type CreateAuctionDocumentTypeInput = z.infer<
  typeof createAuctionDocumentTypeSchema
>;
export type PatchAuctionDocumentTypeInput = z.infer<
  typeof patchAuctionDocumentTypeSchema
>;

import { CommonValidationMessages } from "@auctionit/messages/common";
import { z } from "zod";
import { benchmarkMastersListQuerySchema } from "../masters/list-query.js";

export const benchmarkMaterialsListQuerySchema = benchmarkMastersListQuerySchema;

export type BenchmarkMaterialsListParams = z.infer<
  typeof benchmarkMaterialsListQuerySchema
>;

export const createBenchmarkMaterialMasterSchema = z.object({
  name: z.string().trim().min(1).max(500),
  isActive: z.boolean().optional().default(true),
});

export const patchBenchmarkMaterialMasterSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.isActive !== undefined, {
    message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED,
  });

export type CreateBenchmarkMaterialMasterInput = z.infer<
  typeof createBenchmarkMaterialMasterSchema
>;
export type PatchBenchmarkMaterialMasterInput = z.infer<
  typeof patchBenchmarkMaterialMasterSchema
>;

import { CommonValidationMessages } from "@auctionit/messages/common";
import { z } from "zod";
import { benchmarkMastersListQuerySchema } from "../masters/list-query.js";

export const benchmarkLocationsListQuerySchema = benchmarkMastersListQuerySchema;

export type BenchmarkLocationsListParams = z.infer<
  typeof benchmarkLocationsListQuerySchema
>;

export const createBenchmarkLocationMasterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isActive: z.boolean().optional().default(true),
});

export const patchBenchmarkLocationMasterSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.isActive !== undefined, {
    message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED,
  });

export type CreateBenchmarkLocationMasterInput = z.infer<
  typeof createBenchmarkLocationMasterSchema
>;
export type PatchBenchmarkLocationMasterInput = z.infer<
  typeof patchBenchmarkLocationMasterSchema
>;

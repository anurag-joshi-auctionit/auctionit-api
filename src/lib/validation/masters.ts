import { z } from "zod";
import { dispositionsListQuerySchema } from "../masters/list-query.js";

export const dispositionsMasterListQuerySchema = dispositionsListQuerySchema;

export type DispositionsMasterListParams = z.infer<
  typeof dispositionsMasterListQuerySchema
>;

export const masterCreateSchema = z.object({
  label: z.string().trim().min(1).max(128),
  description: z.string().trim().max(500).optional().default(""),
});

export const masterPatchSchema = z.object({
  label: z.string().trim().min(1).max(128).optional(),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
});

export const bidderMasterCreateSchema = masterCreateSchema.extend({
  requiresLiftedQty: z.boolean().optional().default(false),
  requiresNextFollowup: z.boolean().optional().default(true),
});

export const bidderMasterPatchSchema = masterPatchSchema.extend({
  requiresLiftedQty: z.boolean().optional(),
  requiresNextFollowup: z.boolean().optional(),
});

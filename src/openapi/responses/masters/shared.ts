import { paginated } from "../../common.js";
import { z } from "../../zod.js";

// Shapes shared by the masters routers (src/routes/masters/*).

/**
 * Mirrors Auction/Bidder/ClientDocumentTypeMasterDto in
 * services/masters/{auction,bidder,client}-document-types.service.ts (identical shapes).
 */
export function masterDocumentType(name: string) {
  return z
    .object({
      id: z.number().int(),
      name: z.string(),
      fileNamePrefix: z
        .string()
        .openapi({ description: "Legacy file-name prefix derived from the id on create; not editable." }),
      isActive: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string().nullable(),
    })
    .openapi(name);
}

/**
 * Mirrors BenchmarkMaterialMasterDto / BenchmarkLocationMasterDto in
 * services/masters/benchmark-{materials,locations}.service.ts (identical shapes).
 */
export function masterBenchmarkEntity(name: string) {
  return z
    .object({
      id: z.number().int(),
      name: z.string(),
      isActive: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string().nullable(),
    })
    .openapi(name);
}

/** Mirrors ClientDispositionDto in services/masters/lifting-client-disposition.service.ts. */
export const MasterDisposition = z
  .object({
    id: z.string().openapi({ description: "Numeric id serialised as a string.", example: "1" }),
    label: z.string(),
    description: z.string().openapi({ description: "Empty string when not set." }),
    isActive: z.boolean(),
  })
  .openapi("MasterDisposition");

export const MasterDispositionList = paginated(MasterDisposition).openapi("MasterDispositionList");
export const MasterDispositionOptions = z.array(MasterDisposition).openapi("MasterDispositionOptions");

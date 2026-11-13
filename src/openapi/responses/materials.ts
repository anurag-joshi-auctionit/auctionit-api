import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors MaterialListItem / MaterialListCounts / MaterialListResult in services/materials.service.ts.

export const MaterialCounts = z
  .object({ total: z.number().int(), active: z.number().int(), inactive: z.number().int() })
  .openapi("MaterialCounts");

export const Material = z
  .object({
    id: z.number().int(),
    label: z.string(),
    parentId: z.number().int().nullable(),
    parentLabel: z.string().nullable(),
    breadcrumbLabel: z
      .string()
      .openapi({ description: "Full path from the root, e.g. `Metals → Copper → Scrap`." }),
    depth: z.number().int().openapi({ description: "1 for root materials." }),
    isLeaf: z.boolean().openapi({ description: "True when the material has no children." }),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Material");

export const MaterialPage = paginated(Material, { counts: MaterialCounts }).openapi("MaterialPage");

export const MaterialListResponse = z
  .union([MaterialPage, z.array(Material)])
  .openapi("MaterialListResponse", {
    description: "`MaterialPage` when `page` is in the query string, otherwise a flat array of every material.",
  });

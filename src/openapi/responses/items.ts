import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors ItemListCounts / ItemListRow / ItemListResult in services/items.service.ts.

export const ItemCounts = z
  .object({ total: z.number().int(), active: z.number().int(), inactive: z.number().int() })
  .openapi("ItemCounts");

export const Item = z
  .object({
    itemId: z.number().int(),
    clientId: z.number().int(),
    clientName: z.string(),
    name: z.string().nullable(),
    materialId: z.number().int().nullable(),
    materialLabel: z
      .string()
      .nullable()
      .openapi({ description: "Material breadcrumb, e.g. `Metals → Copper → Scrap`." }),
    benchmarkMaterialId: z.number().int().nullable(),
    benchmarkMaterialLabel: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi("Item");

export const ItemList = paginated(Item, { counts: ItemCounts }).openapi("ItemList");

export const ItemOptions = z
  .object({ options: z.array(z.object({ id: z.number().int(), name: z.string().nullable() })) })
  .openapi("ItemOptions");

import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors BenchmarkComboListRow / BenchmarkComboListCounts / BenchmarkComboListResult in
// services/benchmark-material-locations.service.ts.

export const BenchmarkCurrency = z.enum(["INR", "USD"]).openapi("BenchmarkCurrency");

export const BenchmarkComboCounts = z
  .object({ total: z.number().int(), active: z.number().int(), inactive: z.number().int() })
  .openapi("BenchmarkComboCounts");

export const BenchmarkCombo = z
  .object({
    id: z.number().int(),
    materialId: z.number().int(),
    material: z.string(),
    locationId: z.number().int(),
    location: z.string(),
    currency: BenchmarkCurrency.openapi({ description: "Currency prices for this combo are entered in." }),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi("BenchmarkCombo");

export const BenchmarkComboList = paginated(BenchmarkCombo, { counts: BenchmarkComboCounts }).openapi(
  "BenchmarkComboList",
);

export const BenchmarkStringList = z.array(z.string()).openapi("BenchmarkStringList");

export const BenchmarkEntityOption = z
  .object({ id: z.number().int(), name: z.string() })
  .openapi("BenchmarkEntityOption");

export const BenchmarkEntityOptionList = z
  .array(BenchmarkEntityOption)
  .openapi("BenchmarkEntityOptionList");

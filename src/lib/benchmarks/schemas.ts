import { CommonValidationMessages } from "@auctionit/messages/common";
import { BenchmarksValidationMessages } from "@auctionit/messages/benchmarks";
import { z } from "zod";
import { BENCHMARK_CURRENCIES } from "../../db/schema/benchmark-material-locations.js";

const currencySchema = z.enum(BENCHMARK_CURRENCIES, {
  errorMap: () => ({ message: BenchmarksValidationMessages.CURRENCY_INVALID }),
});

const requiredString = (message: string, max?: number) => {
  let schema = z
    .string({
      required_error: message,
      invalid_type_error: message,
    })
    .trim()
    .min(1, message);
  if (max != null) schema = schema.max(max, message);
  return schema;
};

function optionalStringArrayQuery() {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value == null) return undefined;
      const parts = Array.isArray(value) ? value : [value];
      const result = parts.flatMap((part) =>
        part
          .split(",")
          .map((segment) => segment.trim())
          .filter(Boolean),
      );
      const unique = [...new Set(result)];
      return unique.length > 0 ? unique : undefined;
    });
}

export const BENCHMARK_COMBO_SORT_FIELDS = [
  "material",
  "location",
  "isActive",
  "createdAt",
  "updatedAt",
] as const;

export const benchmarkCombosListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
  location: z.string().trim().optional(),
  sortBy: z.enum(BENCHMARK_COMBO_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type BenchmarkCombosListParams = z.infer<
  typeof benchmarkCombosListQuerySchema
>;

export const createBenchmarkComboSchema = z.object({
  materialId: z
    .number({
      required_error: BenchmarksValidationMessages.MATERIAL_REQUIRED,
      invalid_type_error: BenchmarksValidationMessages.MATERIAL_REQUIRED,
    })
    .int()
    .positive(BenchmarksValidationMessages.MATERIAL_REQUIRED),
  locationId: z
    .number({
      required_error: BenchmarksValidationMessages.LOCATION_REQUIRED,
      invalid_type_error: BenchmarksValidationMessages.LOCATION_REQUIRED,
    })
    .int()
    .positive(BenchmarksValidationMessages.LOCATION_REQUIRED),
  currency: currencySchema.optional().default("INR"),
  isActive: z.boolean().optional().default(true),
});

export const patchBenchmarkComboSchema = z
  .object({
    materialId: z
      .number()
      .int()
      .positive(BenchmarksValidationMessages.MATERIAL_REQUIRED)
      .optional(),
    locationId: z
      .number()
      .int()
      .positive(BenchmarksValidationMessages.LOCATION_REQUIRED)
      .optional(),
    currency: currencySchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.materialId !== undefined ||
      d.locationId !== undefined ||
      d.currency !== undefined ||
      d.isActive !== undefined,
    { message: CommonValidationMessages.AT_LEAST_ONE_FIELD_REQUIRED },
  );

export const benchmarkEntitySearchQuerySchema = z.object({
  search: z.string().trim().optional(),
});
export type BenchmarkEntitySearchParams = z.infer<
  typeof benchmarkEntitySearchQuerySchema
>;

export type CreateBenchmarkComboInput = z.infer<
  typeof createBenchmarkComboSchema
>;
export type PatchBenchmarkComboInput = z.infer<
  typeof patchBenchmarkComboSchema
>;

export const BENCHMARK_PRICE_SORT_FIELDS = [
  "benchmarkDate",
  "price",
  "material",
  "location",
  "createdAt",
] as const;

export const benchmarkPricesListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  comboId: z.coerce.number().int().positive().optional(),
  location: z.string().trim().optional(),
  material: z.string().trim().optional(),
  benchmarkDate: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  sortBy: z.enum(BENCHMARK_PRICE_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type BenchmarkPricesListParams = z.infer<
  typeof benchmarkPricesListQuerySchema
>;

export const BENCHMARK_PRICE_GRID_SORT_FIELDS = ["material", "location"] as const;

export const benchmarkPricesGridQuerySchema = z.object({
  benchmarkDate: requiredString(BenchmarksValidationMessages.DATE_REQUIRED),
  materials: optionalStringArrayQuery(),
  locations: optionalStringArrayQuery(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(BENCHMARK_PRICE_GRID_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type BenchmarkPricesGridParams = z.infer<
  typeof benchmarkPricesGridQuerySchema
>;

export const benchmarkPriceHistoryQuerySchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(365).optional(),
});

export type BenchmarkPriceHistoryParams = z.infer<
  typeof benchmarkPriceHistoryQuerySchema
>;

const priceValueSchema = z
  .number({
    required_error: BenchmarksValidationMessages.PRICE_REQUIRED,
    invalid_type_error: BenchmarksValidationMessages.PRICE_INVALID,
  })
  .positive(BenchmarksValidationMessages.PRICE_INVALID);

export const benchmarkPriceBulkItemSchema = z.object({
  benchmarkMaterialLocationId: z.number().int().positive(),
  price: priceValueSchema,
});

export const benchmarkPricesBulkSchema = z.object({
  benchmarkDate: requiredString(BenchmarksValidationMessages.DATE_REQUIRED),
  items: z
    .array(benchmarkPriceBulkItemSchema)
    .min(1, BenchmarksValidationMessages.AT_LEAST_ONE_PRICE),
});

export type BenchmarkPricesBulkInput = z.infer<
  typeof benchmarkPricesBulkSchema
>;

import { z } from "zod";

export type MasterListResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

const activeOnlyQuery = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === true || v === "true");

export function createMasterListQuerySchema<
  const T extends readonly [string, ...string[]],
>(sortFields: T) {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().optional(),
    activeOnly: activeOnlyQuery,
    sortBy: z.enum(sortFields).optional(),
    sortOrder: z.enum(["asc", "desc"]).optional(),
  });
}

export type MasterListQueryParams<TSortBy extends string = string> = {
  page: number;
  pageSize: number;
  search?: string;
  activeOnly?: boolean;
  sortBy?: TSortBy;
  sortOrder?: "asc" | "desc";
};

export const DOCUMENT_TYPE_SORT_FIELDS = [
  "id",
  "name",
  "fileNamePrefix",
  "isActive",
  "createdAt",
  "updatedAt",
] as const;

export const DISPOSITION_SORT_FIELDS = [
  "id",
  "label",
  "description",
  "isActive",
] as const;

export const BENCHMARK_MASTER_SORT_FIELDS = [
  "id",
  "name",
  "isActive",
  "createdAt",
  "updatedAt",
] as const;

export const documentTypesListQuerySchema = createMasterListQuerySchema(
  DOCUMENT_TYPE_SORT_FIELDS,
);

export const dispositionsListQuerySchema = createMasterListQuerySchema(
  DISPOSITION_SORT_FIELDS,
);

export const benchmarkMastersListQuerySchema = createMasterListQuerySchema(
  BENCHMARK_MASTER_SORT_FIELDS,
);

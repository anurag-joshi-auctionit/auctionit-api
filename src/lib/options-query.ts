import { z } from "zod";

export const DEFAULT_OPTIONS_LIMIT = 100;
export const MAX_OPTIONS_LIMIT = 100;
export const MAX_SELECT_ALL_IDS = 2000;

export const entityOptionsQuerySchema = z.object({
  q: z.string().optional().default(""),
  /** Only applied for empty search (default browse). Omitted when searching. */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_OPTIONS_LIMIT)
    .optional(),
  ids: z
    .string()
    .optional()
    .transform((value) => {
      if (!value?.trim()) return [] as number[];
      return [
        ...new Set(
          value
            .split(",")
            .map((part) => Number(part.trim()))
            .filter((n) => Number.isInteger(n) && n > 0),
        ),
      ];
    }),
});

export type EntityOptionsQuery = z.infer<typeof entityOptionsQuerySchema>;

/**
 * Empty/browse: cap at DEFAULT_OPTIONS_LIMIT (100).
 * Non-empty search: no limit (return all matches).
 */
export function resolveOptionsLimit(
  q: string | undefined,
  limit?: number,
): number | null {
  if ((q?.trim() ?? "").length > 0) return null;
  return Math.min(
    Math.max(limit ?? DEFAULT_OPTIONS_LIMIT, 1),
    MAX_OPTIONS_LIMIT,
  );
}

export const entityOptionIdsQuerySchema = z.object({
  q: z.string().optional().default(""),
});

export type EntityOptionIdsQuery = z.infer<typeof entityOptionIdsQuerySchema>;

export type EntityOptionIdsResult = {
  ids: number[];
  total: number;
  truncated: boolean;
};

/** Cap matching IDs for Select All. */
export function toOptionIdsResult(
  ids: number[],
  total: number,
): EntityOptionIdsResult {
  const truncated = total > MAX_SELECT_ALL_IDS;
  return {
    ids: ids.slice(0, MAX_SELECT_ALL_IDS),
    total,
    truncated,
  };
}

/** Merge id-resolved rows with search rows; selected ids always included. */
export function mergeOptionsById<T extends { id: number }>(
  byIds: T[],
  searched: T[],
  limit: number | null,
): T[] {
  const map = new Map<number, T>();
  for (const row of byIds) map.set(row.id, row);
  for (const row of searched) {
    if (!map.has(row.id)) map.set(row.id, row);
  }
  const merged = [...map.values()];
  if (limit == null || merged.length <= limit) return merged;
  const idSet = new Set(byIds.map((r) => r.id));
  const kept = merged.filter((r) => idSet.has(r.id));
  for (const row of merged) {
    if (kept.length >= Math.max(limit, idSet.size)) break;
    if (!idSet.has(row.id)) kept.push(row);
  }
  return kept;
}

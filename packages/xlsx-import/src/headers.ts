import { coerceImportCellString } from "./coerce.js";
import type { ImportHeaderDef } from "./types.js";

/** Normalize an Excel header cell for key matching. */
export function normalizeImportHeader(cell: unknown): string {
  return String(cell ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[/\\]/g, "");
}

export type HeaderIndexInput =
  | readonly string[]
  | readonly Pick<ImportHeaderDef, "key" | "label" | "aliases">[];

function toHeaderMatchDefs(
  defs: HeaderIndexInput,
): ReadonlyArray<{ key: string; label: string; aliases: readonly string[] }> {
  if (defs.length === 0) return [];
  const first = defs[0];
  if (typeof first === "string") {
    return (defs as readonly string[]).map((key) => ({
      key,
      label: key,
      aliases: [] as const,
    }));
  }
  return (
    defs as readonly Pick<ImportHeaderDef, "key" | "label" | "aliases">[]
  ).map((d) => ({
    key: d.key,
    label: d.label,
    aliases: d.aliases ?? [],
  }));
}

/**
 * Map row-0 header cells to column indices for known keys.
 * Matches display `label`, legacy `key`, and optional aliases after
 * {@link normalizeImportHeader}.
 */
export function buildHeaderIndexMap(
  headerRow: unknown[],
  defs: HeaderIndexInput,
): {
  columnIndexByKey: Map<string, number>;
  missingKeys: string[];
  /** Display labels for missing columns (for user-facing errors). */
  missingLabels: string[];
} {
  const matchDefs = toHeaderMatchDefs(defs);
  const known = new Map<string, string>();
  for (const d of matchDefs) {
    for (const alias of [d.label, d.key, ...d.aliases]) {
      const norm = normalizeImportHeader(alias);
      if (norm && !known.has(norm)) {
        known.set(norm, d.key);
      }
    }
  }

  const columnIndexByKey = new Map<string, number>();

  headerRow.forEach((cell, index) => {
    const key = known.get(normalizeImportHeader(cell));
    if (key != null && !columnIndexByKey.has(key)) {
      columnIndexByKey.set(key, index);
    }
  });

  const missing = matchDefs.filter((d) => !columnIndexByKey.has(d.key));
  return {
    columnIndexByKey,
    missingKeys: missing.map((d) => d.key),
    missingLabels: missing.map((d) => d.label),
  };
}

export function isImportRowBlank(line: unknown[]): boolean {
  return line.every((c) => coerceImportCellString(c) === "");
}

export function cellByHeaderKey(
  cols: unknown[],
  columnIndexByKey: Map<string, number>,
  key: string,
): unknown {
  const index = columnIndexByKey.get(key);
  if (index == null) return "";
  return cols[index] ?? "";
}

/** Look up display label for an internal header key. */
export function labelForImportHeaderKey(
  headers: readonly ImportHeaderDef[],
  key: string,
): string {
  return headers.find((h) => h.key === key)?.label ?? key;
}

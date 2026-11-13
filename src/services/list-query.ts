import { and, eq, type AnyColumn, type SQL } from "drizzle-orm";

export function clampPagination(page: number, pageSize: number) {
  const clampedPage = Math.max(1, page);
  const clampedPageSize = Math.max(1, Math.min(100, pageSize));
  return {
    page: clampedPage,
    pageSize: clampedPageSize,
    offset: (clampedPage - 1) * clampedPageSize,
  };
}

export function activeInactiveStatus(
  isActiveColumn: AnyColumn,
  status: "all" | "active" | "inactive" | undefined,
): SQL | undefined {
  if (status === "active") return eq(isActiveColumn, true);
  if (status === "inactive") return eq(isActiveColumn, false);
  return undefined;
}

export function combineConditions(conditions: (SQL | undefined)[]): SQL | undefined {
  const defined = conditions.filter((c): c is SQL => c != null);
  return defined.length ? and(...defined) : undefined;
}

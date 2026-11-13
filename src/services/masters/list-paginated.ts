import {
  asc,
  count,
  desc,
  eq,
  ilike,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type {
  MasterListQueryParams,
  MasterListResult,
} from "../../lib/masters/list-query.js";
import { db } from "../../db/index.js";
import { clampPagination, combineConditions } from "../list-query.js";

export function buildMasterSearchCondition(
  search: string | undefined,
  columns: AnyColumn[],
  idColumn?: AnyColumn,
): SQL | undefined {
  const term = search?.trim();
  if (!term) return undefined;

  const pattern = `%${term}%`;
  const parts: SQL[] = columns.map((column) => ilike(column, pattern));
  if (idColumn) {
    parts.push(ilike(sql`cast(${idColumn} as text)`, pattern));
  }
  return or(...parts);
}

export function resolveMasterOrderBy(
  sortColumns: Record<string, AnyColumn>,
  sortBy: string | undefined,
  sortOrder: "asc" | "desc" | undefined,
  defaultOrderBy: SQL[],
): SQL[] {
  if (!sortBy) return defaultOrderBy;
  const column = sortColumns[sortBy];
  if (!column) return defaultOrderBy;
  return [(sortOrder ?? "asc") === "desc" ? desc(column) : asc(column)];
}

export async function listPaginatedMaster<TRow, TDto>(opts: {
  table: PgTable;
  isActiveColumn: AnyColumn;
  searchColumns: AnyColumn[];
  searchIdColumn?: AnyColumn;
  sortColumns: Record<string, AnyColumn>;
  defaultOrderBy: SQL[];
  params: MasterListQueryParams;
  toDto: (row: TRow) => TDto;
}): Promise<MasterListResult<TDto>> {
  const { page, pageSize, offset } = clampPagination(
    opts.params.page,
    opts.params.pageSize,
  );

  const where = combineConditions([
    opts.params.activeOnly ? eq(opts.isActiveColumn, true) : undefined,
    buildMasterSearchCondition(
      opts.params.search,
      opts.searchColumns,
      opts.searchIdColumn,
    ),
  ]);

  const orderBy = resolveMasterOrderBy(
    opts.sortColumns,
    opts.params.sortBy,
    opts.params.sortOrder,
    opts.defaultOrderBy,
  );

  // Drizzle's from() requires a concrete table generic; masters share this helper.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = opts.table as any;

  const [countRow] = await db
    .select({ total: count() })
    .from(table)
    .where(where);

  const rows = (await db
    .select()
    .from(table)
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset)) as TRow[];

  return {
    items: rows.map((row) => opts.toDto(row)),
    total: Number(countRow?.total ?? 0),
    page,
    pageSize,
  };
}

import { sql, type SQL } from "drizzle-orm";

/** Executor that can run raw SQL (db or a transaction client). */
export type SqlExecutor = {
  // Intentionally loose: drizzle `db` / `tx`.execute return QueryResult shapes
  // that vary by driver generics; we only need rows + rowCount at call sites.
  execute: (query: SQL) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

function uniquePositiveIds(ids: number[]): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0) out.add(id);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Concurrent-safe set-union of integer IDs onto a Postgres int[] column.
 * No-op when `ids` is empty or already a subset of the current array.
 */
export async function unionIntArrayColumn(
  executor: SqlExecutor,
  opts: {
    table: "clients" | "bidders";
    column: "materials" | "bidders";
    rowId: number;
    ids: number[];
    updatedBy?: number | null;
  },
): Promise<boolean> {
  const ids = uniquePositiveIds(opts.ids);
  if (ids.length === 0) return false;

  const idsSql = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;

  const updatedBy =
    opts.updatedBy != null && Number.isInteger(opts.updatedBy)
      ? opts.updatedBy
      : null;

  const result = await executor.execute(sql`
    UPDATE ${sql.raw(opts.table)}
    SET ${sql.raw(opts.column)} = (
      SELECT COALESCE(
        ARRAY(
          SELECT DISTINCT x
          FROM unnest(${sql.raw(opts.column)} || ${idsSql}) AS t(x)
          ORDER BY x
        ),
        '{}'::int[]
      )
    ),
    updated_at = now(),
    updated_by = COALESCE(${updatedBy}, updated_by)
    WHERE id = ${opts.rowId}
      AND NOT (${sql.raw(opts.column)} @> ${idsSql})
  `);

  return (result.rowCount ?? 0) > 0;
}

export async function unionClientMaterials(
  executor: SqlExecutor,
  clientId: number,
  materialIds: number[],
  updatedBy?: number | null,
): Promise<boolean> {
  return unionIntArrayColumn(executor, {
    table: "clients",
    column: "materials",
    rowId: clientId,
    ids: materialIds,
    updatedBy,
  });
}

export async function unionClientBidders(
  executor: SqlExecutor,
  clientId: number,
  bidderIds: number[],
  updatedBy?: number | null,
): Promise<boolean> {
  return unionIntArrayColumn(executor, {
    table: "clients",
    column: "bidders",
    rowId: clientId,
    ids: bidderIds,
    updatedBy,
  });
}

export async function unionBidderMaterials(
  executor: SqlExecutor,
  bidderId: number,
  materialIds: number[],
  updatedBy?: number | null,
): Promise<boolean> {
  return unionIntArrayColumn(executor, {
    table: "bidders",
    column: "materials",
    rowId: bidderId,
    ids: materialIds,
    updatedBy,
  });
}

/** Pure helper for tests / in-memory set merge. */
export function mergeIntSets(
  existing: number[] | null | undefined,
  incoming: number[],
): number[] {
  return uniquePositiveIds([...(existing ?? []), ...incoming]);
}

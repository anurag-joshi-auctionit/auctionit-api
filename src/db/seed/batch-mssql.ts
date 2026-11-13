import mssql from "mssql";

/** Default page size for large MSSQL → Postgres seeds (~100k). */
export const DEFAULT_SEED_BATCH_SIZE = 100_000;

/** Hard cap so SEED_BATCH_SIZE cannot recreate full-table heap OOM. */
export const MAX_SEED_BATCH_SIZE = 1_000_000;

/**
 * Resolve batch size from SEED_BATCH_SIZE env, falling back to
 * {@link DEFAULT_SEED_BATCH_SIZE} and clamping to [1, {@link MAX_SEED_BATCH_SIZE}].
 */
export function resolveSeedBatchSize(): number {
  const raw = process.env.SEED_BATCH_SIZE;
  if (raw == null || raw.trim() === "") return DEFAULT_SEED_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SEED_BATCH_SIZE;
  return Math.min(Math.floor(n), MAX_SEED_BATCH_SIZE);
}

/** `SELECT COUNT_BIG(1) AS cnt FROM ${fromClause}` — fromClause is trusted seed SQL. */
export async function countMssqlRows(
  pool: mssql.ConnectionPool,
  fromClause: string,
): Promise<number> {
  const result = await pool
    .request()
    .query<{ cnt: string | number }>(
      `SELECT COUNT_BIG(1) AS cnt FROM ${fromClause}`,
    );
  const cnt = result.recordset[0]?.cnt;
  return Number(cnt ?? 0);
}

export type MssqlBatchPage<T> = {
  rows: T[];
  /** 1-based batch index. */
  batchIndex: number;
  /** Max id in this page (keyset cursor for the next page). */
  lastId: number;
};

export type FetchMssqlBatchesOpts<T> = {
  /** Column list / expressions (no FROM / WHERE / ORDER BY). */
  selectList: string;
  /** Table or JOIN clause after FROM (trusted seed SQL). */
  fromClause: string;
  /** Physical id column for keyset filter + ORDER BY (e.g. `Id`). */
  idColumn: string;
  /** Read the numeric id from a mapped row. */
  getRowId: (row: T) => number;
  batchSize?: number;
  /** Resume from this id (exclusive). Rows with id <= startFromId are skipped. */
  startFromId?: number;
};

/**
 * Keyset-paginated MSSQL reads. Yields one page at a time so callers can
 * process and discard before loading the next page (avoids heap OOM on
 * multi-million-row tables).
 */
export async function* fetchMssqlBatches<T extends object>(
  pool: mssql.ConnectionPool,
  opts: FetchMssqlBatchesOpts<T>,
): AsyncGenerator<MssqlBatchPage<T>> {
  const batchSize = opts.batchSize ?? resolveSeedBatchSize();
  const sql = `
SELECT ${opts.selectList}
FROM ${opts.fromClause}
WHERE ${opts.idColumn} > @lastId
ORDER BY ${opts.idColumn}
OFFSET 0 ROWS FETCH NEXT @batchSize ROWS ONLY
`;

  let lastId = opts.startFromId ?? 0;
  let batchIndex = 0;

  for (;;) {
    const result = await pool
      .request()
      .input("lastId", mssql.BigInt, lastId)
      .input("batchSize", mssql.Int, batchSize)
      .query<T>(sql);

    const rows = result.recordset;
    if (rows.length === 0) return;

    batchIndex += 1;
    const pageLastId = opts.getRowId(rows[rows.length - 1]!);
    yield { rows, batchIndex, lastId: pageLastId };

    if (rows.length < batchSize) return;
    lastId = pageLastId;
  }
}

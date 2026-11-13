import type pg from "pg";

/**
 * Batched writes for the MSSQL → Postgres seeds. Row-at-a-time writes against
 * a remote Postgres cost one round trip per row, which stalls on 1L+ rows.
 */

/** Rows per multi-row upsert; keeps rows × columns under Postgres' 65535 bind-param limit for tables up to 65 columns. */
const BATCH_SIZE = 1000;
const PROGRESS_EVERY = 10_000;

/**
 * Upserts `rows` in multi-row batches and logs progress. `head` is the
 * `INSERT INTO t (cols)` part and `tail` the `ON CONFLICT …` part; each row
 * holds the values for `cols` in order.
 */
export async function upsertBatched(
  client: pg.PoolClient,
  label: string,
  head: string,
  tail: string,
  rows: unknown[][],
): Promise<void> {
  const total = rows.length;
  let nextLog = PROGRESS_EVERY;
  const batchStarted = Date.now();
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      const start = params.length;
      params.push(...row);
      return `(${row.map((_, c) => `$${start + c + 1}`).join(", ")})`;
    });
    await client.query(`${head} VALUES ${tuples.join(",\n")} ${tail}`, params);
    const done = Math.min(i + BATCH_SIZE, total);
    if (done >= nextLog || done === total) {
      console.log(
        `  ${label}: ${done}/${total} (${Math.round((done / total) * 100)}%, ${Math.round((Date.now() - batchStarted) / 1000)}s)`,
      );
      while (nextLog <= done) nextLog += PROGRESS_EVERY;
    }
  }
}

/** Rows per JSON-batched UPDATE. */
const UPDATE_BATCH_SIZE = 5000;

/**
 * Runs `sql` over `rows` in batches, passing each batch as a JSON array in
 * `$1` (read it with `json_to_recordset($1::json) AS v(...)`), and logs progress.
 */
export async function updateBatched(
  client: pg.PoolClient,
  label: string,
  sql: string,
  rows: object[],
): Promise<void> {
  const total = rows.length;
  let nextLog = PROGRESS_EVERY;
  const batchStarted = Date.now();
  for (let i = 0; i < total; i += UPDATE_BATCH_SIZE) {
    await client.query(sql, [JSON.stringify(rows.slice(i, i + UPDATE_BATCH_SIZE))]);
    const done = Math.min(i + UPDATE_BATCH_SIZE, total);
    if (done >= nextLog || done === total) {
      console.log(
        `  ${label}: ${done}/${total} (${Math.round((done / total) * 100)}%, ${Math.round((Date.now() - batchStarted) / 1000)}s)`,
      );
      while (nextLog <= done) nextLog += PROGRESS_EVERY;
    }
  }
}

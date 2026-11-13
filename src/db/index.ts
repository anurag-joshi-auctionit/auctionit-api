import { drizzle } from "drizzle-orm/node-postgres";
import type { Logger } from "drizzle-orm/logger";
import pg from "pg";
import { env } from "../env.js";
import * as schema from "./schema/index.js";
import { relations } from "./schema/relations.js";

// Pin the session timezone to Asia/Kolkata for `::date` casts and lot
// schedule SQL (`timestamp AT TIME ZONE 'Asia/Kolkata'`). Instant columns are
// `timestamptz` (UTC); this does not change their stored absolute time.
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_POOL_IDLE_MS,
  connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
  options: `-c timezone=Asia/Kolkata${
    env.DB_STATEMENT_TIMEOUT_MS > 0
      ? ` -c statement_timeout=${env.DB_STATEMENT_TIMEOUT_MS}`
      : ""
  }`,
});

export type PoolMetrics = {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
};

/** Snapshot of the node-postgres pool — for /health and live diagnostics. */
export function getPoolMetrics(): PoolMetrics {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

// Logs every SQL statement (and its params) to the console when DB_LOG_SQL=true.
class ConsoleSqlLogger implements Logger {
  logQuery(query: string, params: unknown[]): void {
    const compact = query.replace(/\s+/g, " ").trim();
    if (params.length > 0) {
      console.log(`[sql] ${compact} -- params: ${JSON.stringify(params)}`);
    } else {
      console.log(`[sql] ${compact}`);
    }
  }
}

export const db = drizzle({
  client: pool,
  schema,
  relations,
  logger: env.DB_LOG_SQL ? new ConsoleSqlLogger() : false,
});
export { schema, pool };

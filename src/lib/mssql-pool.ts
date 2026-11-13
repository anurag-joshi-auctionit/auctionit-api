import mssql from "mssql";
import { env } from "../env.js";

export function isMssqlConfigured(): boolean {
  return !!(
    env.MSSQL_SERVER &&
    env.MSSQL_USER &&
    env.MSSQL_PASSWORD &&
    env.MSSQL_DATABASE
  );
}

let pool: mssql.ConnectionPool | null = null;

export async function getMssqlPool(): Promise<mssql.ConnectionPool | null> {
  if (!isMssqlConfigured()) return null;
  if (!pool) {
    pool = await mssql.connect({
      server: env.MSSQL_SERVER!,
      port: env.MSSQL_PORT,
      user: env.MSSQL_USER!,
      password: env.MSSQL_PASSWORD!,
      database: env.MSSQL_DATABASE!,
      options: {
        encrypt: env.MSSQL_ENCRYPT,
        trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
      },
    });
  }
  return pool;
}

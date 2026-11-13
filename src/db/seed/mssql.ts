import mssql from "mssql";
import { env } from "../../env.js";

export async function connectMssql(): Promise<mssql.ConnectionPool> {
  if (
    !env.MSSQL_SERVER ||
    !env.MSSQL_USER ||
    !env.MSSQL_PASSWORD ||
    !env.MSSQL_DATABASE
  ) {
    throw new Error(
      "MSSQL_SERVER, MSSQL_USER, MSSQL_PASSWORD and MSSQL_DATABASE must be set in .env to run seeds.",
    );
  }
  return mssql.connect({
    server: env.MSSQL_SERVER,
    port: env.MSSQL_PORT,
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    database: env.MSSQL_DATABASE,
    options: {
      encrypt: env.MSSQL_ENCRYPT,
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
    },
  });
}

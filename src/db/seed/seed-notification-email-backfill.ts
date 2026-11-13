/**
 * One-time idempotent import:
 * 1) Seed `notification_types` from legacy `tbl_Config_Notification`
 * 2) Import email rows from `tbl_Data_EmailNotificationLog` into
 *    `notification_email_logs` (id = legacy Id; terminal sent/failed only)
 * 3) Advance the Postgres identity sequence past MAX(id)
 *
 * Requires MSSQL_* env vars. Safe to re-run (upsert on PK).
 * Uses keyset MSSQL paging + UNNEST batch upserts.
 */
import mssql from "mssql";
import pg from "pg";
import { env } from "../../env.js";
import { resolveSeedBatchSize } from "./batch-mssql.js";
import { connectMssql } from "./mssql.js";

const PG_INSERT_CHUNK = 2_000;

const MODULE_TYPES_SQL = `
INSERT INTO notification_types (id, description, is_active, created_at)
VALUES
  (1000, 'Service Invoice — Annexure Email', true, now()),
  (1001, 'Subscription — Invoice Email', true, now()),
  (1002, 'Ad-hoc Send Email', true, now())
ON CONFLICT (id) DO NOTHING
`;

const UPSERT_TYPE_SQL = `
INSERT INTO notification_types (
  id, description, is_active, created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, NULL, $5, NULL
)
ON CONFLICT (id) DO UPDATE SET
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at
`;

const UPSERT_LOGS_SQL = `
INSERT INTO notification_email_logs (
  id, auction_id, notification_id, status, email_to, email_cc, email_bcc,
  email_body, attempts, created_at, sent_at
)
SELECT
  v.id,
  v.auction_id,
  v.notification_id,
  v.status,
  v.email_to,
  v.email_cc,
  v.email_bcc,
  v.email_body,
  v.attempts,
  v.created_at,
  v.sent_at
FROM UNNEST(
  $1::int[],
  $2::int[],
  $3::int[],
  $4::text[],
  $5::text[],
  $6::text[],
  $7::text[],
  $8::text[],
  $9::int[],
  $10::timestamptz[],
  $11::timestamptz[]
) AS v(
  id, auction_id, notification_id, status, email_to, email_cc, email_bcc,
  email_body, attempts, created_at, sent_at
)
ON CONFLICT (id) DO UPDATE SET
  auction_id = EXCLUDED.auction_id,
  notification_id = EXCLUDED.notification_id,
  status = EXCLUDED.status,
  email_to = EXCLUDED.email_to,
  email_cc = EXCLUDED.email_cc,
  email_bcc = EXCLUDED.email_bcc,
  email_body = EXCLUDED.email_body,
  attempts = EXCLUDED.attempts,
  created_at = EXCLUDED.created_at,
  sent_at = EXCLUDED.sent_at
`;

type SourceRow = {
  Id: number;
  AuctionId: number;
  NotificationId: number;
  IsError: boolean | number | null;
  LogDataTime: string | Date | null;
  ErrorDateTime: string | Date | null;
  ToEmailId: string | null;
  CCEmailId: string | null;
  BCC: string | null;
  EmailContant: string | null;
};

type PreparedLog = {
  id: number;
  auctionId: number | null;
  notificationId: number;
  status: "sent" | "failed";
  emailTo: string;
  emailCc: string | null;
  emailBcc: string | null;
  emailBody: string;
  attempts: number;
  createdAt: string;
  sentAt: string;
};

function asIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function isErrorFlag(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

async function insertChunk(
  client: pg.PoolClient,
  rows: PreparedLog[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await client.query(UPSERT_LOGS_SQL, [
    rows.map((r) => r.id),
    rows.map((r) => r.auctionId),
    rows.map((r) => r.notificationId),
    rows.map((r) => r.status),
    rows.map((r) => r.emailTo),
    rows.map((r) => r.emailCc),
    rows.map((r) => r.emailBcc),
    rows.map((r) => r.emailBody),
    rows.map((r) => r.attempts),
    rows.map((r) => r.createdAt),
    rows.map((r) => r.sentAt),
  ]);
  return rows.length;
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  // Large keyset pages + wide EmailContant columns need a longer request timeout.
  (mssqlPool as unknown as { config: { requestTimeout: number } }).config.requestTimeout =
    10 * 60 * 1000;

  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const pgClient = await pool.connect();

  try {
    // --- notification_types from tbl_Config_Notification ---
    const typesResult = await mssqlPool.request().query<{
      NotificationId: number;
      Notification: string;
      IsActive: boolean | null;
      CreatedDate: Date;
      UpdatedDate: Date | null;
    }>(`
      SELECT NotificationId, Notification, IsActive, CreatedDate, UpdatedDate
      FROM tbl_Config_Notification
      ORDER BY NotificationId
    `);

    await pgClient.query("BEGIN");
    let typeCount = 0;
    for (const row of typesResult.recordset) {
      await pgClient.query(UPSERT_TYPE_SQL, [
        row.NotificationId,
        row.Notification?.slice(0, 100) ?? `Notification ${row.NotificationId}`,
        row.IsActive ?? true,
        asIso(row.CreatedDate) ?? new Date().toISOString(),
        asIso(row.UpdatedDate),
      ]);
      typeCount += 1;
    }
    await pgClient.query(MODULE_TYPES_SQL);
    await pgClient.query("COMMIT");
    console.log(`Upserted ${typeCount} notification_types from legacy.`);

    const typeIdsResult = await pgClient.query<{ id: number }>(
      `SELECT id FROM notification_types`,
    );
    const knownTypeIds = new Set(typeIdsResult.rows.map((r) => r.id));

    const batchSize = resolveSeedBatchSize();
    const existingMax = await pgClient.query<{ max: string | null }>(
      `SELECT MAX(id)::text AS max FROM notification_email_logs`,
    );
    let lastId = Number(existingMax.rows[0]?.max ?? 0);
    let batchIndex = 0;
    let imported = 0;
    let skippedMissingType = 0;

    console.log(
      `Importing email logs with keyset pages of ${batchSize} (ToEmailId not null), resuming after id=${lastId}...`,
    );

    const pageSql = `
SELECT TOP (@batchSize)
  Id,
  AuctionId,
  NotificationId,
  IsError,
  CONVERT(varchar(33), LogDataTime, 126) AS LogDataTime,
  CONVERT(varchar(33), ErrorDateTime, 126) AS ErrorDateTime,
  ToEmailId,
  CCEmailId,
  BCC,
  EmailContant
FROM tbl_Data_EmailNotificationLog
WHERE Id > @lastId
  AND ToEmailId IS NOT NULL
  AND LTRIM(RTRIM(ToEmailId)) <> ''
ORDER BY Id
`;

    for (;;) {
      const page = await mssqlPool
        .request()
        .input("lastId", mssql.BigInt, lastId)
        .input("batchSize", mssql.Int, batchSize)
        .query<SourceRow>(pageSql);

      if (page.recordset.length === 0) break;
      batchIndex += 1;

      const prepared: PreparedLog[] = [];
      for (const row of page.recordset) {
        lastId = row.Id;
        if (!knownTypeIds.has(row.NotificationId)) {
          skippedMissingType += 1;
          continue;
        }
        const emailTo = asText(row.ToEmailId);
        if (!emailTo) continue;

        const status = isErrorFlag(row.IsError) ? "failed" : "sent";
        const createdAt = asIso(row.LogDataTime) ?? new Date().toISOString();
        const sentAt =
          status === "sent"
            ? createdAt
            : (asIso(row.ErrorDateTime) ?? createdAt);
        const auctionId =
          row.AuctionId && row.AuctionId !== 0 ? row.AuctionId : null;

        prepared.push({
          id: row.Id,
          auctionId,
          notificationId: row.NotificationId,
          status,
          emailTo,
          emailCc: asText(row.CCEmailId),
          emailBcc: asText(row.BCC),
          emailBody: asText(row.EmailContant) ?? "",
          attempts: 1,
          createdAt,
          sentAt,
        });
      }

      await pgClient.query("BEGIN");
      try {
        for (let i = 0; i < prepared.length; i += PG_INSERT_CHUNK) {
          const chunk = prepared.slice(i, i + PG_INSERT_CHUNK);
          imported += await insertChunk(pgClient, chunk);
        }
        await pgClient.query("COMMIT");
      } catch (err) {
        await pgClient.query("ROLLBACK");
        throw err;
      }

      console.log(
        `Batch ${batchIndex}: upserted through id=${lastId} (total ${imported}, +${prepared.length} this page)...`,
      );

      if (page.recordset.length < batchSize) break;
    }

    const seq = await pgClient.query<{ max: string | null }>(
      `SELECT MAX(id)::text AS max FROM notification_email_logs`,
    );
    const maxId = Number(seq.rows[0]?.max ?? 0);
    if (maxId > 0) {
      await pgClient.query(
        `SELECT setval(pg_get_serial_sequence('notification_email_logs', 'id'), $1, true)`,
        [maxId],
      );
      console.log(`Advanced identity sequence to ${maxId}.`);
    }

    console.log(
      `Done in ${Date.now() - started}ms. imported=${imported}, skippedMissingType=${skippedMissingType}`,
    );
  } catch (err) {
    try {
      await pgClient.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    pgClient.release();
    await pool.end();
    await mssqlPool.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

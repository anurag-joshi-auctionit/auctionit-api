import { appendFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { env } from "../../env.js";
import {
  buildNewClientDocumentFileName,
  legacyClientDocumentTypePrefix,
} from "../../lib/client-document-naming.js";
import { fileUploadService } from "../../services/file-upload.service.js";
import {
  extensionForAuctionDocumentKind,
  MAX_AUCTION_DOCUMENT_BYTES,
  sniffAuctionDocumentKind,
} from "../../lib/auction-r2-keys.js";
import { deleteObject } from "../../lib/r2.js";
import { CLIENT_DOCUMENT_TYPE_TNC } from "../schema/client-document-types.js";
import {
  resolveAuditUserId,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";

const TNC_PREFIX = legacyClientDocumentTypePrefix(CLIENT_DOCUMENT_TYPE_TNC);

const SOURCE_SQL = `
SELECT
  ClientId AS clientId,
  TnC AS blob,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy AS updatedBy
FROM tbl_Config_ClientMst
WHERE TnC IS NOT NULL
ORDER BY ClientId
`;

const RESET_DELETE_TNC_LOGS_SQL = `
DELETE FROM client_document_logs
WHERE document_type_id = $1
`;

const RESET_DELETE_ORPHAN_FILES_SQL = `
DELETE FROM files
WHERE s3_key LIKE 'clients/tnc_%'
`;

const INSERT_SQL = `
INSERT INTO client_document_logs (
  id, client_id, document_type_id, file_name, s3_key,
  is_active, created_at, created_by
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8
)
`;

type SourceRow = {
  clientId: number;
  blob: Buffer | Uint8Array | string;
  createdAt: string | null;
  createdBy: number | null;
  updatedAt: string | null;
  updatedBy: number | null;
};

type ReportRow = {
  clientId: number;
  storageFileName: string;
  status: string;
  note: string;
};

type Candidate = {
  clientId: number;
  row: SourceRow;
  buffer: Buffer;
  originalFileName: string;
  createdAt: Date;
};

function parseReportPath(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith("--report=")) return arg.slice("--report=".length);
  }
  return null;
}

function parseLimit(argv: string[]): number | null {
  const raw = argv.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("--limit must be a positive integer.");
  }
  return n;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

async function writeReportHeader(reportPath: string): Promise<void> {
  await writeFile(
    reportPath,
    "client_id,storage_file_name,status,note\n",
  );
}

async function appendReportRow(reportPath: string, row: ReportRow): Promise<void> {
  const line = [
    row.clientId,
    csvEscape(row.storageFileName),
    row.status,
    csvEscape(row.note),
  ].join(",");
  await appendFile(reportPath, `${line}\n`);
}

function toBuffer(blob: SourceRow["blob"]): Buffer {
  if (Buffer.isBuffer(blob)) return blob;
  if (blob instanceof Uint8Array) return Buffer.from(blob);
  return Buffer.from(blob);
}

function parseCreatedAt(value: string | null): Date {
  if (!value?.trim()) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function main() {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set to seed client documents.",
    );
  }

  const argv = process.argv.slice(2);
  const reportPath = parseReportPath(argv);
  const limit = parseLimit(argv);
  const reset = hasFlag(argv, "--reset");
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    if (reportPath) await writeReportHeader(reportPath);

    if (reset) {
      const resetClient = await pgPool.connect();
      try {
        await resetClient.query("BEGIN");
        await resetClient.query(RESET_DELETE_TNC_LOGS_SQL, [
          CLIENT_DOCUMENT_TYPE_TNC,
        ]);
        await resetClient.query(RESET_DELETE_ORPHAN_FILES_SQL);
        await resetClient.query("COMMIT");
        console.log(
          "Reset client_document_logs for Terms & Conditions and orphan files rows for clients/tnc_*.",
        );
      } catch (err) {
        await resetClient.query("ROLLBACK");
        throw err;
      } finally {
        resetClient.release();
      }
    }

    const tncResult = await mssqlPool.request().query(SOURCE_SQL);
    console.log(
      `Pulled ${tncResult.recordset.length} client TnC rows from MSSQL.`,
    );

    const [clientRows, userRows, existingTncRows, maxIdRows] = await Promise.all([
      pgPool.query<{ id: number }>(`SELECT id FROM clients`),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
      pgPool.query<{ clientId: number }>(
        `SELECT DISTINCT client_id AS "clientId"
         FROM client_document_logs
         WHERE document_type_id = $1 AND is_active = true`,
        [CLIENT_DOCUMENT_TYPE_TNC],
      ),
      pgPool.query<{ maxId: number | null }>(
        `SELECT COALESCE(MAX(id), 0) AS "maxId" FROM client_document_logs`,
      ),
    ]);

    const clientIds = new Set(clientRows.rows.map((r) => r.id));
    const existingTncClientIds = new Set(
      existingTncRows.rows.map((r) => r.clientId),
    );
    const validUserIds = new Set(userRows.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);
    let nextId = Number(maxIdRows.rows[0]?.maxId ?? 0) + 1;

    const candidates: Candidate[] = [];
    let skippedMissingClient = 0;
    let skippedEmptyBlob = 0;
    let skippedTooLarge = 0;
    let skippedInvalidType = 0;
    let skippedAlreadyPresent = 0;

    for (const raw of tncResult.recordset as SourceRow[]) {
      const clientId = Number(raw.clientId);

      if (!clientIds.has(clientId)) {
        skippedMissingClient++;
        if (reportPath) {
          await appendReportRow(reportPath, {
            clientId,
            storageFileName: "",
            status: "missing_fk",
            note: "client not in postgres",
          });
        }
        continue;
      }

      if (existingTncClientIds.has(clientId)) {
        skippedAlreadyPresent++;
        if (reportPath) {
          await appendReportRow(reportPath, {
            clientId,
            storageFileName: "",
            status: "already_present",
            note: "active type-2 log exists",
          });
        }
        continue;
      }

      const buffer = toBuffer(raw.blob);
      if (!buffer.length) {
        skippedEmptyBlob++;
        if (reportPath) {
          await appendReportRow(reportPath, {
            clientId,
            storageFileName: "",
            status: "empty_blob",
            note: "",
          });
        }
        continue;
      }

      if (buffer.length > MAX_AUCTION_DOCUMENT_BYTES) {
        skippedTooLarge++;
        if (reportPath) {
          await appendReportRow(reportPath, {
            clientId,
            storageFileName: "",
            status: "too_large",
            note: `${buffer.length} bytes`,
          });
        }
        continue;
      }

      const kind = sniffAuctionDocumentKind(buffer);
      if (!kind) {
        skippedInvalidType++;
        if (reportPath) {
          await appendReportRow(reportPath, {
            clientId,
            storageFileName: "",
            status: "invalid_type",
            note: "not pdf/docx magic",
          });
        }
        continue;
      }

      candidates.push({
        clientId,
        row: raw,
        buffer,
        originalFileName: `document${extensionForAuctionDocumentKind(kind)}`,
        createdAt: parseCreatedAt(raw.createdAt),
      });
    }

    let limited = candidates;
    if (limit != null) limited = candidates.slice(0, limit);

    console.log(
      `Kept ${limited.length} client TnC documents; ` +
        `${skippedMissingClient} skipped: client not in Postgres, ` +
        `${skippedAlreadyPresent} skipped: already present, ` +
        `${skippedEmptyBlob} skipped: empty blob, ` +
        `${skippedTooLarge} skipped: too large, ` +
        `${skippedInvalidType} skipped: invalid type.`,
    );

    const client = await pgPool.connect();
    let inserted = 0;
    let uploadFailed = 0;

    try {
      for (const candidate of limited) {
        const { clientId, row, buffer, originalFileName, createdAt } = candidate;
        let uploaded: { storageFileName: string; s3Key: string } | null = null;

        try {
          const result = await fileUploadService.upload(
            { buffer, originalFilename: originalFileName },
            {
              folder: "clients",
              buildFileName: (orig) =>
                buildNewClientDocumentFileName({
                  prefix: TNC_PREFIX,
                  clientId,
                  originalFileName: orig,
                  at: createdAt,
                }),
            },
          );
          uploaded = { storageFileName: result.fileName, s3Key: result.s3Key };
        } catch (err) {
          uploadFailed++;
          const note = err instanceof Error ? err.message : "upload failed";
          console.warn(`R2 failed client=${clientId}: ${note}`);
          if (reportPath) {
            await appendReportRow(reportPath, {
              clientId,
              storageFileName: "",
              status: "r2_failed",
              note,
            });
          }
          continue;
        }

        try {
          await client.query("BEGIN");
          const createdBy = resolveAuditUserId(
            Number(row.createdBy),
            validUserIds,
          );
          const id = nextId++;
          await client.query(INSERT_SQL, [
            id,
            clientId,
            CLIENT_DOCUMENT_TYPE_TNC,
            uploaded.storageFileName,
            uploaded.s3Key,
            true,
            row.createdAt ?? createdAt.toISOString(),
            createdBy,
          ]);
          await client.query("COMMIT");
          existingTncClientIds.add(clientId);
          inserted++;
          if (reportPath) {
            await appendReportRow(reportPath, {
              clientId,
              storageFileName: uploaded.storageFileName,
              status: "ok",
              note: "",
            });
          }
        } catch (err) {
          await client.query("ROLLBACK");
          try {
            await deleteObject(uploaded.s3Key);
          } catch {
            // best-effort
          }
          uploadFailed++;
          const note = err instanceof Error ? err.message : "db failed";
          console.warn(`DB failed client=${clientId}: ${note}`);
          if (reportPath) {
            await appendReportRow(reportPath, {
              clientId,
              storageFileName: uploaded.storageFileName,
              status: "db_failed",
              note,
            });
          }
        }
      }
    } finally {
      client.release();
    }

    console.log(
      `Inserted ${inserted} client TnC documents ` +
        `(${skippedMissingClient} skipped: client not in Postgres, ` +
        `${skippedAlreadyPresent} skipped: already present, ` +
        `${skippedEmptyBlob} skipped: empty blob, ` +
        `${skippedTooLarge} skipped: too large, ` +
        `${skippedInvalidType} skipped: invalid type, ` +
        `${uploadFailed} skipped: migrate failed) ` +
        `in ${Date.now() - started}ms.`,
    );
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

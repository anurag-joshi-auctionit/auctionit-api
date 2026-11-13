import { appendFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { env } from "../../env.js";
import { buildNewBidderDocumentFileName } from "../../lib/bidder-document-naming.js";
import {
  resolveBidderDocumentStorageFileName,
  type BidderDocumentUploadResult,
} from "../../lib/bidder-document-upload.js";
import { contentTypeForBidderFileName } from "../../lib/bidder-r2-keys.js";
import {
  discoverLegacyTempBidderFiles,
  isHttpLegacyTempBidderRoot,
  readLegacyTempBidderFile,
  requireLegacyTempBidderInfoPath,
} from "../../lib/legacy-temp-bidder-files.js";
import { putObject } from "../../lib/r2.js";
import {
  resolveAuditUserId,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import { legacyAvailFlagToIsActive } from "./legacy-flags.js";

const SOURCE_SQL = `
SELECT
  RecId           AS id,
  BidderCompid    AS bidderId,
  DocumentTypeId  AS documentTypeId,
  FileName        AS fileName,
  AvailFlag       AS availFlag,
  CreatedBy       AS createdBy,
  CONVERT(varchar(33), CreatedDate, 126) AS createdAt,
  ModifiedBy      AS updatedBy,
  CONVERT(varchar(33), ModifiedDate, 126) AS updatedAt
FROM tbl_Data_BidderDocuments
ORDER BY RecId
`;

const RESET_DELETE_ORPHAN_FILES_SQL = `
DELETE FROM files WHERE s3_key LIKE 'bidders/%'
`;

const RESET_TRUNCATE_DOCUMENTS_SQL = `TRUNCATE bidder_document_logs`;

const INSERT_DOCUMENT_SQL = `
INSERT INTO bidder_document_logs (
  id, bidder_id, document_type_id, file_name, s3_key, is_active,
  created_at, created_by
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8
)
`;

const BACKFILL_CANCELLED_CHEQUE_SQL = `
UPDATE bidder_bank_accounts b
SET cancelled_cheque_file_name = d.file_name
FROM (
  SELECT DISTINCT ON (bidder_id)
    bidder_id, file_name
  FROM bidder_document_logs
  WHERE document_type_id = 4
    AND is_active = true
    AND file_name IS NOT NULL
    AND file_name <> ''
  ORDER BY bidder_id, created_at DESC, id DESC
) d
WHERE b.bidder_id = d.bidder_id
`;

type SourceRow = {
  id: number;
  bidderId: number | null;
  documentTypeId: number | null;
  fileName: string | null;
  availFlag: number | null;
  createdBy: number | null;
  createdAt: string | null;
  updatedBy: number | null;
  updatedAt: string | null;
};

type ReportRow = {
  recId: number;
  bidderId: number;
  documentTypeId: number;
  sourceFileName: string;
  storageFileName: string;
  status: string;
  note: string;
};

type ValidatedSourceRow = SourceRow & {
  bidderId: number;
  documentTypeId: number;
};

type CandidateRow = {
  row: ValidatedSourceRow;
  sourceFileName: string;
  resolved: BidderDocumentUploadResult;
};

function parseMssqlCreatedAt(value: string | null): Date {
  if (!value?.trim()) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function parseReportPath(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith("--report=")) {
      return arg.slice("--report=".length);
    }
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

function parsePrescanConcurrency(argv: string[]): number {
  const raw = argv
    .find((a) => a.startsWith("--prescan-concurrency="))
    ?.slice("--prescan-concurrency=".length);
  if (!raw) return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("--prescan-concurrency must be a positive integer.");
  }
  return n;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function isMissingLegacyFileError(message: string): boolean {
  return (
    message.includes("ENOENT") ||
    message.includes("HTTP 404") ||
    message.includes("not found") ||
    message.includes("Legacy file not found")
  );
}

async function writeReportHeader(reportPath: string): Promise<void> {
  await writeFile(
    reportPath,
    "rec_id,bidder_id,document_type_id,legacy_file_name,storage_file_name,status,note\n",
  );
}

async function appendReportRow(reportPath: string, row: ReportRow): Promise<void> {
  const line = [
    row.recId,
    row.bidderId,
    row.documentTypeId,
    csvEscape(row.sourceFileName),
    csvEscape(row.storageFileName),
    row.status,
    csvEscape(row.note),
  ].join(",");
  await appendFile(reportPath, `${line}\n`);
}

function logPrescanProgress(
  label: string,
  done: number,
  total: number,
  found: number,
): void {
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  console.log(`  ${label}: ${done}/${total} (${pct}%, ${found} found)`);
}

async function main() {
  requireLegacyTempBidderInfoPath();

  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set to upload bidder documents.",
    );
  }

  const argv = process.argv.slice(2);
  const reportPath = parseReportPath(argv);
  const limit = parseLimit(argv);
  const usePrescan = !hasFlag(argv, "--no-prescan");
  const skipMissing = !hasFlag(argv, "--no-skip-missing");
  const prescanConcurrency = parsePrescanConcurrency(argv);
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const uploadUserId = Number(process.env.SEED_UPLOAD_USER_ID ?? "1");

  try {
    const userCheck = await pgPool.query<{ id: number }>(
      "SELECT id FROM users WHERE id = $1",
      [uploadUserId],
    );
    if (userCheck.rows.length === 0) {
      throw new Error(
        `SEED_UPLOAD_USER_ID=${uploadUserId} does not exist in users table.`,
      );
    }

    const [typeRows, bidderRows, userRows] = await Promise.all([
      pgPool.query<{ id: number; fileNamePrefix: string }>(
        "SELECT id, file_name_prefix AS \"fileNamePrefix\" FROM bidder_document_types",
      ),
      pgPool.query<{ id: number }>("SELECT id FROM bidders"),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
    ]);

    const prefixByTypeId = new Map(
      typeRows.rows.map((r) => [r.id, r.fileNamePrefix]),
    );
    const validBidderIds = new Set(bidderRows.rows.map((r) => r.id));
    const validTypeIds = new Set(typeRows.rows.map((r) => r.id));
    const validUserIds = new Set(userRows.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(RESET_TRUNCATE_DOCUMENTS_SQL);
      await client.query(RESET_DELETE_ORPHAN_FILES_SQL);
      await client.query("COMMIT");
      console.log("Reset bidder_document_logs and orphan files rows for bidders/*.");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    let sourceSql = SOURCE_SQL;
    if (limit != null) {
      sourceSql = sourceSql.replace("ORDER BY RecId", `ORDER BY RecId OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`);
    }

    const result = await mssqlPool.request().query<SourceRow>(sourceSql);
    console.log(
      `Loaded ${result.recordset.length} MSSQL bidder document rows.`,
    );

    if (reportPath) {
      await writeReportHeader(reportPath);
    }

    let skippedMissingBidder = 0;
    let skippedMissingType = 0;
    let skippedEmptyFilename = 0;
    const candidates: CandidateRow[] = [];

    for (const row of result.recordset) {
      if (row.bidderId == null || !validBidderIds.has(row.bidderId)) {
        skippedMissingBidder++;
        continue;
      }
      if (row.documentTypeId == null || !validTypeIds.has(row.documentTypeId)) {
        skippedMissingType++;
        continue;
      }
      if (!row.fileName?.trim()) {
        skippedEmptyFilename++;
        continue;
      }

      const prefix = prefixByTypeId.get(row.documentTypeId);
      if (!prefix) {
        skippedMissingType++;
        continue;
      }

      const sourceFileName = row.fileName.trim();
      const storageFileName = buildNewBidderDocumentFileName({
        prefix,
        bidderId: row.bidderId,
        originalFileName: sourceFileName,
        at: parseMssqlCreatedAt(row.createdAt),
      });
      const resolved = resolveBidderDocumentStorageFileName(storageFileName);
      candidates.push({
        row: { ...row, bidderId: row.bidderId, documentTypeId: row.documentTypeId },
        sourceFileName,
        resolved,
      });
    }

    console.log(
      `${candidates.length} rows eligible after Postgres bidder/type/filename checks ` +
        `(${skippedMissingBidder} skipped: bidder, ${skippedMissingType} skipped: type, ` +
        `${skippedEmptyFilename} skipped: empty filename).`,
    );

    let existingLegacyFiles = new Set<string>();

    if (usePrescan && candidates.length > 0) {
      const uniqueLegacyFileNames = [
        ...new Set(candidates.map((c) => c.sourceFileName)),
      ];
      const legacyRoot = requireLegacyTempBidderInfoPath();
      const scanMode = isHttpLegacyTempBidderRoot()
        ? `HTTP directory listing, else HEAD in batches of ${prescanConcurrency}`
        : "local directory listing";
      console.log(
        `Pre-scanning ${uniqueLegacyFileNames.length} unique legacy filenames via ${scanMode}...`,
      );
      const prescanStarted = Date.now();
      existingLegacyFiles = await discoverLegacyTempBidderFiles(
        uniqueLegacyFileNames,
        {
          concurrency: prescanConcurrency,
          onProgress: ({ done, total, found, mode }) => {
            if (mode === "http-listing" || mode === "local-listing") {
              console.log(
                `  Legacy file pre-scan: directory listing found ${found}/${total} matches.`,
              );
              return;
            }
            logPrescanProgress("Legacy file pre-scan", done, total, found);
          },
        },
      );
      console.log(
        `Pre-scan found ${existingLegacyFiles.size}/${uniqueLegacyFileNames.length} legacy files at ${legacyRoot} in ${Date.now() - prescanStarted}ms.`,
      );
    }

    const rowsToMigrate =
      usePrescan && skipMissing
        ? candidates.filter((c) => existingLegacyFiles.has(c.sourceFileName))
        : candidates;

    let inserted = 0;
    let missingFile =
      usePrescan && skipMissing
        ? candidates.length - rowsToMigrate.length
        : 0;
    let uploadError = 0;

    if (usePrescan && missingFile > 0) {
      console.log(
        `Migrating ${rowsToMigrate.length} rows with legacy files (${missingFile} skipped: no legacy file).`,
      );
    }

    const pgClient = await pgPool.connect();
    try {
      for (const [index, candidate] of rowsToMigrate.entries()) {
        const { row, sourceFileName, resolved } = candidate;

        let legacyBuffer: Buffer;
        try {
          legacyBuffer = await readLegacyTempBidderFile(sourceFileName);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isMissingLegacyFileError(message)) {
            missingFile++;
            console.warn(
              `Skipped RecId=${row.id} bidder=${row.bidderId} type=${row.documentTypeId} file=${sourceFileName} (missing_file): ${message}`,
            );
            if (reportPath) {
              await appendReportRow(reportPath, {
                recId: row.id,
                bidderId: row.bidderId,
                documentTypeId: row.documentTypeId,
                sourceFileName,
                storageFileName: "",
                status: "missing_file",
                note: message,
              });
            }
            continue;
          }
          uploadError++;
          console.warn(
            `Skipped RecId=${row.id} bidder=${row.bidderId} type=${row.documentTypeId} file=${sourceFileName} (fetch_error): ${message}`,
          );
          if (reportPath) {
            await appendReportRow(reportPath, {
              recId: row.id,
              bidderId: row.bidderId,
              documentTypeId: row.documentTypeId,
              sourceFileName,
              storageFileName: "",
              status: "fetch_error",
              note: message,
            });
          }
          continue;
        }

        try {
          await pgClient.query("BEGIN");

          const createdBy = resolveAuditUserId(row.createdBy, validUserIds);
          const now = new Date().toISOString();

          await pgClient.query(INSERT_DOCUMENT_SQL, [
            row.id,
            row.bidderId,
            row.documentTypeId,
            resolved.storageFileName,
            resolved.s3Key,
            legacyAvailFlagToIsActive(row.availFlag),
            row.createdAt ?? now,
            createdBy,
          ]);

          await pgClient.query("COMMIT");

          try {
            await putObject({
              key: resolved.s3Key,
              body: legacyBuffer,
              contentType: contentTypeForBidderFileName(
                resolved.storageFileName,
              ),
            });
          } catch (uploadErr) {
            await pgClient.query(
              `DELETE FROM bidder_document_logs WHERE id = $1`,
              [row.id],
            );
            throw uploadErr;
          }

          inserted++;
          if (reportPath) {
            await appendReportRow(reportPath, {
              recId: row.id,
              bidderId: row.bidderId,
              documentTypeId: row.documentTypeId,
              sourceFileName,
              storageFileName: resolved.storageFileName,
              status: "migrated",
              note: resolved.s3Key,
            });
          }
        } catch (err) {
          await pgClient.query("ROLLBACK");
          const message = err instanceof Error ? err.message : String(err);
          uploadError++;
          console.warn(
            `Skipped RecId=${row.id} bidder=${row.bidderId} type=${row.documentTypeId} file=${sourceFileName} (upload_error): ${message}`,
          );
          if (reportPath) {
            await appendReportRow(reportPath, {
              recId: row.id,
              bidderId: row.bidderId,
              documentTypeId: row.documentTypeId,
              sourceFileName,
              storageFileName: resolved.storageFileName,
              status: "upload_error",
              note: message,
            });
          }
        }

        if ((index + 1) % 100 === 0) {
          console.log(
            `Progress ${index + 1}/${rowsToMigrate.length} — inserted=${inserted} missing=${missingFile} errors=${uploadError}`,
          );
        }
      }
    } finally {
      pgClient.release();
    }

    const backfill = await pgPool.query(BACKFILL_CANCELLED_CHEQUE_SQL);

    console.log(
      `Inserted ${inserted} bidder document log rows ` +
        `(${skippedMissingBidder} skipped: bidder not in Postgres, ` +
        `${skippedMissingType} skipped: type not in Postgres, ` +
        `${skippedEmptyFilename} skipped: empty filename, ` +
        `${missingFile} missing legacy file, ` +
        `${uploadError} upload errors). ` +
        `Backfilled cancelled_cheque_file_name on ${backfill.rowCount ?? 0} bank accounts ` +
        `in ${Date.now() - started}ms.`,
    );
    if (reportPath) {
      console.log(`Report written to ${reportPath}`);
    }
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

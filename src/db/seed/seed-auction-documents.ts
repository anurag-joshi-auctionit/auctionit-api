import { appendFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { env } from "../../env.js";
import { uploadAuctionDocumentBytesToR2 } from "../../lib/auction-document-upload.js";
import {
  extensionForAuctionDocumentKind,
  MAX_AUCTION_DOCUMENT_BYTES,
  resolveAuctionDocumentStorage,
  sniffAuctionDocumentKind,
} from "../../lib/auction-r2-keys.js";
import { legacyAuctionDocumentTypePrefix } from "../../lib/auction-document-naming.js";
import { deleteObject } from "../../lib/r2.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";

type DocumentType = "catalogue" | "tnc";

const DOCUMENT_TYPE_IDS: Record<DocumentType, number> = {
  catalogue: 1,
  tnc: 2,
};

const CATALOGUE_SOURCE_SQL = `
SELECT
  CatalogId AS sourceId,
  AuctionId AS auctionId,
  Catalog AS blob,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy AS updatedBy
FROM tbl_Data_AuctionCatalog
WHERE Catalog IS NOT NULL
ORDER BY AuctionId, IsActive DESC, VersionNumber DESC, CreateDatetime DESC, CatalogId DESC
`;

const TNC_SOURCE_SQL = `
SELECT
  [T&CID] AS sourceId,
  AuctionId AS auctionId,
  TnC AS blob,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy AS updatedBy
FROM tbl_Data_AuctionTnC
WHERE TnC IS NOT NULL
ORDER BY AuctionId, IsActive DESC, CreateDatetime DESC, [T&CID] DESC
`;

const RESET_TRUNCATE_SQL = `TRUNCATE auction_documents RESTART IDENTITY CASCADE`;
const RESET_DELETE_ORPHAN_FILES_SQL = `
DELETE FROM files
WHERE s3_key LIKE 'auctions/catalogues/%'
   OR s3_key LIKE 'auctions/tnc/%'
`;

const UPSERT_SQL = `
INSERT INTO auction_documents (
  id, auction_id, document_type_id, file_name, s3_key,
  is_active, created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9, $10
)
ON CONFLICT (auction_id, document_type_id) DO UPDATE SET
  file_name = EXCLUDED.file_name,
  s3_key = EXCLUDED.s3_key,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
  sourceId: number;
  auctionId: number;
  blob: Buffer | Uint8Array | string;
  createdAt: string;
  createdBy: number;
  updatedAt: string | null;
  updatedBy: number | null;
};

type ReportRow = {
  documentType: DocumentType;
  sourceId: number;
  auctionId: number;
  clientId: number;
  storageFileName: string;
  status: string;
  note: string;
};

type Candidate = {
  documentType: DocumentType;
  row: SourceRow;
  clientId: number;
  buffer: Buffer;
  storage: { filename: string; s3Key: string };
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

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

async function writeReportHeader(reportPath: string): Promise<void> {
  await writeFile(
    reportPath,
    "document_type,source_id,auction_id,client_id,storage_file_name,status,note\n",
  );
}

async function appendReportRow(reportPath: string, row: ReportRow): Promise<void> {
  const line = [
    row.documentType,
    row.sourceId,
    row.auctionId,
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

async function collectCandidates(opts: {
  documentType: DocumentType;
  rows: SourceRow[];
  auctionById: Map<number, { clientId: number }>;
  reportPath: string | null;
}): Promise<{
  candidates: Candidate[];
  skippedMissingAuction: number;
  skippedEmptyBlob: number;
  skippedTooLarge: number;
  skippedInvalidType: number;
  skippedSuperseded: number;
}> {
  const kept = new Map<number, Candidate>();
  let skippedMissingAuction = 0;
  let skippedEmptyBlob = 0;
  let skippedTooLarge = 0;
  let skippedInvalidType = 0;
  let skippedSuperseded = 0;

  for (const raw of opts.rows) {
    const auctionId = Number(raw.auctionId);
    const auctionMeta = opts.auctionById.get(auctionId);
    const reportBase = {
      documentType: opts.documentType,
      sourceId: Number(raw.sourceId),
      auctionId,
    };

    if (auctionMeta == null) {
      skippedMissingAuction++;
      if (opts.reportPath) {
        await appendReportRow(opts.reportPath, {
          ...reportBase,
          clientId: 0,
          storageFileName: "",
          status: "missing_fk",
          note: "auction not in postgres",
        });
      }
      continue;
    }

    const { clientId } = auctionMeta;

    const buffer = toBuffer(raw.blob);
    if (!buffer.length) {
      skippedEmptyBlob++;
      if (opts.reportPath) {
        await appendReportRow(opts.reportPath, {
          ...reportBase,
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
      if (opts.reportPath) {
        await appendReportRow(opts.reportPath, {
          ...reportBase,
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
      if (opts.reportPath) {
        await appendReportRow(opts.reportPath, {
          ...reportBase,
          clientId,
          storageFileName: "",
          status: "invalid_type",
          note: "not pdf/docx magic",
        });
      }
      continue;
    }

    if (kept.has(auctionId)) {
      skippedSuperseded++;
      if (opts.reportPath) {
        await appendReportRow(opts.reportPath, {
          ...reportBase,
          clientId,
          storageFileName: "",
          status: "superseded",
          note: `another ${opts.documentType} kept for auction`,
        });
      }
      continue;
    }

    const documentTypeId = DOCUMENT_TYPE_IDS[opts.documentType];
    const storage = resolveAuctionDocumentStorage({
      documentTypeId,
      fileNamePrefix: legacyAuctionDocumentTypePrefix(documentTypeId),
      auctionId,
      clientId,
      originalFileName: `document${extensionForAuctionDocumentKind(kind)}`,
    });

    kept.set(auctionId, {
      documentType: opts.documentType,
      row: raw,
      clientId,
      buffer,
      storage,
    });
  }

  return {
    candidates: [...kept.values()],
    skippedMissingAuction,
    skippedEmptyBlob,
    skippedTooLarge,
    skippedInvalidType,
    skippedSuperseded,
  };
}

async function main() {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set to seed auction documents.",
    );
  }

  const argv = process.argv.slice(2);
  const reportPath = parseReportPath(argv);
  const limit = parseLimit(argv);
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    if (reportPath) await writeReportHeader(reportPath);

    const resetClient = await pgPool.connect();
    try {
      await resetClient.query("BEGIN");
      await resetClient.query(RESET_TRUNCATE_SQL);
      await resetClient.query(RESET_DELETE_ORPHAN_FILES_SQL);
      await resetClient.query("COMMIT");
      console.log(
        "Reset auction_documents and orphan files rows for auctions/catalogues/* and auctions/tnc/*.",
      );
    } catch (err) {
      await resetClient.query("ROLLBACK");
      throw err;
    } finally {
      resetClient.release();
    }

    const [catalogueResult, tncResult] = await Promise.all([
      mssqlPool.request().query(CATALOGUE_SOURCE_SQL),
      mssqlPool.request().query(TNC_SOURCE_SQL),
    ]);
    console.log(
      `Pulled ${catalogueResult.recordset.length} catalogues and ${tncResult.recordset.length} TnC rows from MSSQL.`,
    );

    const [auctionRows, userRows] = await Promise.all([
      pgPool.query<{ id: number; clientId: number }>(
        `SELECT auction_id AS id, client_id AS "clientId" FROM auctions`,
      ),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
    ]);
    const auctionById = new Map(
      auctionRows.rows.map((r) => [r.id, { clientId: r.clientId }] as const),
    );
    const validUserIds = new Set(userRows.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);

    const cataloguePart = await collectCandidates({
      documentType: "catalogue",
      rows: catalogueResult.recordset as SourceRow[],
      auctionById,
      reportPath,
    });
    const tncPart = await collectCandidates({
      documentType: "tnc",
      rows: tncResult.recordset as SourceRow[],
      auctionById,
      reportPath,
    });

    let candidates = [...cataloguePart.candidates, ...tncPart.candidates];
    if (limit != null) candidates = candidates.slice(0, limit);
    const skippedMissingAuction =
      cataloguePart.skippedMissingAuction + tncPart.skippedMissingAuction;
    const skippedEmptyBlob =
      cataloguePart.skippedEmptyBlob + tncPart.skippedEmptyBlob;
    const skippedTooLarge =
      cataloguePart.skippedTooLarge + tncPart.skippedTooLarge;
    const skippedInvalidType =
      cataloguePart.skippedInvalidType + tncPart.skippedInvalidType;
    const skippedSuperseded =
      cataloguePart.skippedSuperseded + tncPart.skippedSuperseded;
    console.log(
      `Part 1 kept ${candidates.length} documents (1:1 per type); ` +
        `${skippedMissingAuction} skipped: auction not in Postgres, ` +
        `${skippedEmptyBlob} skipped: empty blob, ` +
        `${skippedTooLarge} skipped: too large, ` +
        `${skippedInvalidType} skipped: invalid type, ` +
        `${skippedSuperseded} skipped: superseded duplicate.`,
    );

    const client = await pgPool.connect();
    let upserted = 0;
    let uploadFailed = 0;
    let nextId = 1;

    try {
      for (const candidate of candidates) {
        const { documentType, row, clientId, buffer, storage } = candidate;
        try {
          await uploadAuctionDocumentBytesToR2({
            s3Key: storage.s3Key,
            buffer,
            filename: storage.filename,
          });
        } catch (err) {
          uploadFailed++;
          const note = err instanceof Error ? err.message : "upload failed";
          console.warn(
            `R2 failed ${documentType} source=${row.sourceId} auction=${row.auctionId}: ${note}`,
          );
          if (reportPath) {
            await appendReportRow(reportPath, {
              documentType,
              sourceId: Number(row.sourceId),
              auctionId: Number(row.auctionId),
              clientId,
              storageFileName: storage.filename,
              status: "r2_verify_failed",
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
          const updatedBy = resolveAuditUserIdIfTimestamp(
            row.updatedAt,
            row.updatedBy == null ? null : Number(row.updatedBy),
            validUserIds,
          );
          const id = nextId++;

          await client.query(UPSERT_SQL, [
            id,
            Number(row.auctionId),
            DOCUMENT_TYPE_IDS[documentType],
            storage.filename,
            storage.s3Key,
            true,
            row.createdAt,
            createdBy,
            row.updatedAt,
            updatedBy,
          ]);
          await client.query("COMMIT");
          upserted++;
          if (reportPath) {
            await appendReportRow(reportPath, {
              documentType,
              sourceId: Number(row.sourceId),
              auctionId: Number(row.auctionId),
              clientId,
              storageFileName: storage.filename,
              status: "ok",
              note: "",
            });
          }
        } catch (err) {
          await client.query("ROLLBACK");
          try {
            await deleteObject(storage.s3Key);
          } catch {
            // best-effort
          }
          uploadFailed++;
          const note = err instanceof Error ? err.message : "db failed";
          console.warn(
            `DB failed ${documentType} source=${row.sourceId} auction=${row.auctionId}: ${note}`,
          );
          if (reportPath) {
            await appendReportRow(reportPath, {
              documentType,
              sourceId: Number(row.sourceId),
              auctionId: Number(row.auctionId),
              clientId,
              storageFileName: storage.filename,
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
      `Upserted ${upserted} auction_documents ` +
        `(${skippedMissingAuction} skipped: auction not in Postgres, ` +
        `${skippedEmptyBlob} skipped: empty blob, ` +
        `${skippedTooLarge} skipped: too large, ` +
        `${skippedInvalidType} skipped: invalid type, ` +
        `${skippedSuperseded} skipped: superseded duplicate, ` +
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

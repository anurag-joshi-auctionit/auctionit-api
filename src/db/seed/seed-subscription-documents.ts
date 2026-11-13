/**
 * Phase R2 — upload legacy subscription invoice PDFs to R2 and upsert
 * subscription_documents rows (1:1 per subscription + Invoice PDF type).
 *
 * Run AFTER seed:subscriptions and seed:subscription-document-types.
 * Idempotent: skips rows that already have an active document with s3_key.
 */
import pg from "pg";
import { env } from "../../env.js";
import { SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF } from "../../lib/subscriptions/subscription-document-naming.js";
import {
  resolveAuditUserId,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import { asString } from "./resolve-location-id.js";

const SOURCE_SQL = `
SELECT
  PaymentId AS subscriptionId,
  BidderCompId AS bidderId,
  FileName AS fileName,
  InvoiceGeneratedBy AS generatedBy,
  CONVERT(varchar(33), InvoiceUploadDateTime, 126) AS generatedAt
FROM tbl_Data_PaymentTransaction
WHERE FileName IS NOT NULL AND LTRIM(RTRIM(FileName)) <> ''
ORDER BY PaymentId
`;

type SourceRow = {
  subscriptionId: number | string;
  bidderId: number | string | null;
  fileName: string | null;
  generatedBy: number | string | null;
  generatedAt: string | null;
};

function toId(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isMissingFileError(msg: string): boolean {
  return (
    msg.includes("HTTP 404") ||
    msg.includes("ENOENT") ||
    msg.includes("no such file")
  );
}

async function nextDocumentId(client: pg.PoolClient): Promise<number> {
  const res = await client.query<{ next_id: number }>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM subscription_documents`,
  );
  return Number(res.rows[0]?.next_id ?? 1);
}

async function upsertDocument(
  client: pg.PoolClient,
  opts: {
    subscriptionId: number;
    documentTypeId: number;
    fileName: string;
    s3Key: string;
    createdBy: number;
    createdAt: string | null;
  },
): Promise<void> {
  const existing = await client.query<{ id: number }>(
    `SELECT id FROM subscription_documents
     WHERE subscription_id = $1 AND document_type_id = $2
     LIMIT 1`,
    [opts.subscriptionId, opts.documentTypeId],
  );
  const now = new Date().toISOString();
  if (existing.rows[0]) {
    await client.query(
      `UPDATE subscription_documents
       SET file_name = $1, s3_key = $2, is_active = true,
           updated_at = $3, updated_by = $4
       WHERE id = $5`,
      [
        opts.fileName,
        opts.s3Key,
        now,
        opts.createdBy,
        existing.rows[0].id,
      ],
    );
    return;
  }
  const id = await nextDocumentId(client);
  await client.query(
    `INSERT INTO subscription_documents (
      id, subscription_id, document_type_id, file_name, s3_key,
      is_active, created_at, created_by, updated_at, updated_by
    ) VALUES ($1, $2, $3, $4, $5, true, $6, $7, NULL, NULL)`,
    [
      id,
      opts.subscriptionId,
      opts.documentTypeId,
      opts.fileName,
      opts.s3Key,
      opts.createdAt ?? now,
      opts.createdBy,
    ],
  );
}

/** Active rows with non-null s3_key per (subscription, type). */
async function loadExistingDocKeys(
  pool: pg.Pool,
  subscriptionIds: number[],
): Promise<Map<string, true>> {
  const existing = new Map<string, true>();
  if (subscriptionIds.length === 0) return existing;
  const res = await pool.query<{
    subscription_id: number;
    document_type_id: number;
  }>(
    `SELECT subscription_id, document_type_id
     FROM subscription_documents
     WHERE subscription_id = ANY($1::int[])
       AND is_active = true
       AND s3_key IS NOT NULL`,
    [subscriptionIds],
  );
  for (const r of res.rows) {
    existing.set(`${r.subscription_id}:${r.document_type_id}`, true);
  }
  return existing;
}

function hasDoc(
  existing: Map<string, true>,
  subscriptionId: number,
  typeId: number,
): boolean {
  return existing.has(`${subscriptionId}:${typeId}`);
}

async function main() {
  const started = Date.now();
  const legacyPdfDir = env.LEGACY_SUBSCRIPTION_INVOICE_PDF_DIR?.trim();
  if (!legacyPdfDir) {
    console.warn(
      "LEGACY_SUBSCRIPTION_INVOICE_PDF_DIR unset — skipping subscription invoice PDF upload to R2.",
    );
    return;
  }

  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} subscription invoice file hints from MSSQL.`,
    );

    const pgSubs = await pgPool.query<{
      id: number;
      bidder_id: number;
    }>(`SELECT id, bidder_id FROM subscriptions`);
    const subById = new Map(pgSubs.rows.map((r) => [r.id, r]));
    console.log(`Loaded ${subById.size} subscriptions rows from Postgres.`);

    const userIds = new Set(
      (await pgPool.query<{ id: number }>("SELECT id FROM users")).rows.map(
        (r) => r.id,
      ),
    );
    userIds.add(SEED_DEFAULT_USER_ID);

    type LegacyHint = {
      bidderId: number;
      fileName: string;
      generatedBy: number;
      generatedAt: string | null;
    };
    const legacyFiles = new Map<number, LegacyHint>();
    for (const r of result.recordset) {
      const id = toId(r.subscriptionId);
      const fileName = asString(r.fileName);
      if (id == null || !fileName || !subById.has(id)) continue;
      const pgBidderId = subById.get(id)!.bidder_id;
      legacyFiles.set(id, {
        bidderId: pgBidderId,
        fileName,
        generatedBy: resolveAuditUserId(toId(r.generatedBy), userIds),
        generatedAt: r.generatedAt?.trim() || null,
      });
    }

    const existing = await loadExistingDocKeys(pgPool, [...subById.keys()]);

    const {
      persistSubscriptionInvoicePdf,
      readLegacySubscriptionInvoiceFile,
    } = await import("../../lib/subscriptions/invoice-r2.js");

    const client = await pgPool.connect();
    try {
      let uploaded = 0;
      let missingFile = 0;
      let uploadError = 0;
      let candidates = 0;
      let statusPatched = 0;

      for (const [id, hints] of legacyFiles) {
        if (hasDoc(existing, id, SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF)) {
          continue;
        }
        candidates++;
        try {
          const buffer = await readLegacySubscriptionInvoiceFile(
            legacyPdfDir,
            hints.fileName,
          );
          if (!buffer.length) {
            missingFile++;
            continue;
          }
          const stored = await persistSubscriptionInvoicePdf({
            subscriptionId: id,
            bidderId: hints.bidderId,
            buffer,
          });
          await upsertDocument(client, {
            subscriptionId: id,
            documentTypeId: SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF,
            fileName: stored.filename,
            s3Key: stored.s3Key,
            createdBy: hints.generatedBy,
            createdAt: hints.generatedAt,
          });
          existing.set(
            `${id}:${SUBSCRIPTION_DOCUMENT_TYPE_INVOICE_PDF}`,
            true,
          );
          uploaded++;

          const patched = await client.query(
            `UPDATE subscriptions
             SET invoice_status = 'generated',
                 invoice_generated_at = COALESCE(invoice_generated_at, $2),
                 invoice_generated_by = COALESCE(invoice_generated_by, $3)
             WHERE id = $1 AND invoice_status <> 'generated'`,
            [id, hints.generatedAt, hints.generatedBy],
          );
          statusPatched += patched.rowCount ?? 0;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isMissingFileError(msg)) {
            missingFile++;
          } else {
            uploadError++;
            console.warn(
              `Subscription invoice PDF R2 failed id=${id} file=${hints.fileName}: ${msg}`,
            );
          }
        }
      }

      console.log(
        `Subscription invoice PDF R2 upload: ${uploaded} uploaded, ${missingFile} missing file, ${uploadError} errors, ${candidates} candidates, ${statusPatched} status patched (dir=${legacyPdfDir}) in ${Date.now() - started}ms.`,
      );
    } finally {
      client.release();
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

/**
 * Phase R2 — upload legacy/auto service invoice files to R2 and upsert
 * service_invoice_documents rows (1:1 per invoice + document type).
 *
 * Run AFTER seed:service-invoices and seed:service-invoice-document-types.
 * Idempotent: skips types that already have an active row with s3_key.
 * Prefer a clean reseed after schema push so R2 keys use stable (no-epoch) names.
 */
import pg from "pg";
import { env } from "../../env.js";
import { connectMssql } from "./mssql.js";
import { asString } from "./resolve-location-id.js";
import {
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
  SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
} from "../../lib/service-invoices/service-invoice-document-naming.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

const SOURCE_SQL = `
SELECT
  ServiceInvoiceId AS serviceInvoiceId,
  ClientId AS clientId,
  AnnexureFileName AS annexureFileName,
  FileName AS fileName
FROM tbl_Data_ServiceInvoice
`;

type SourceRow = {
  serviceInvoiceId: number;
  clientId: number | null;
  annexureFileName: string | null;
  fileName: string | null;
};

type LegacyFileHints = {
  clientId: number;
  annexureXlsx: string | null;
  annexurePdf: string | null;
  invoicePdf: string | null;
};

function toId(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function splitPdfFilenames(fileName: string | null): {
  annexurePdf: string | null;
  invoicePdf: string | null;
} {
  const parts = (fileName ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { annexurePdf: null, invoicePdf: null };
  }
  if (parts.length === 1) {
    return { annexurePdf: parts[0] ?? null, invoicePdf: null };
  }
  return {
    annexurePdf: parts[0] ?? null,
    invoicePdf: parts[1] ?? null,
  };
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
    `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM service_invoice_documents`,
  );
  return Number(res.rows[0]?.next_id ?? 1);
}

async function upsertDocument(
  client: pg.PoolClient,
  opts: {
    serviceInvoiceId: number;
    documentTypeId: number;
    fileName: string;
    s3Key: string;
  },
): Promise<void> {
  const existing = await client.query<{ id: number }>(
    `SELECT id FROM service_invoice_documents
     WHERE service_invoice_id = $1 AND document_type_id = $2
     LIMIT 1`,
    [opts.serviceInvoiceId, opts.documentTypeId],
  );
  const now = new Date().toISOString();
  if (existing.rows[0]) {
    await client.query(
      `UPDATE service_invoice_documents
       SET file_name = $1, s3_key = $2, is_active = true,
           updated_at = $3, updated_by = $4
       WHERE id = $5`,
      [
        opts.fileName,
        opts.s3Key,
        now,
        SEED_DEFAULT_USER_ID,
        existing.rows[0].id,
      ],
    );
    return;
  }
  const id = await nextDocumentId(client);
  await client.query(
    `INSERT INTO service_invoice_documents (
      id, service_invoice_id, document_type_id, file_name, s3_key,
      is_active, created_at, created_by, updated_at, updated_by
    ) VALUES ($1, $2, $3, $4, $5, true, $6, $7, NULL, NULL)`,
    [
      id,
      opts.serviceInvoiceId,
      opts.documentTypeId,
      opts.fileName,
      opts.s3Key,
      now,
      SEED_DEFAULT_USER_ID,
    ],
  );
}

/** Active rows with non-null s3_key per (invoice, type). */
async function loadExistingDocKeys(
  pool: pg.Pool,
  invoiceIds: number[],
): Promise<Map<string, true>> {
  const existing = new Map<string, true>();
  if (invoiceIds.length === 0) return existing;
  const res = await pool.query<{
    service_invoice_id: number;
    document_type_id: number;
  }>(
    `SELECT service_invoice_id, document_type_id
     FROM service_invoice_documents
     WHERE service_invoice_id = ANY($1::int[])
       AND is_active = true
       AND s3_key IS NOT NULL`,
    [invoiceIds],
  );
  for (const r of res.rows) {
    existing.set(`${r.service_invoice_id}:${r.document_type_id}`, true);
  }
  return existing;
}

function hasDoc(
  existing: Map<string, true>,
  invoiceId: number,
  typeId: number,
): boolean {
  return existing.has(`${invoiceId}:${typeId}`);
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} service invoice file hints from MSSQL.`,
    );

    const pgInvoices = await pgPool.query<{
      id: number;
      client_id: number;
      type: string;
      service_fee_type: string;
      plant_location_id: number;
      from_date: string;
      to_date: string;
    }>(
      `SELECT id, client_id, type, service_fee_type, plant_location_id, from_date, to_date
       FROM service_invoices`,
    );
    const invoiceById = new Map(pgInvoices.rows.map((r) => [r.id, r]));
    console.log(
      `Loaded ${invoiceById.size} service_invoices rows from Postgres.`,
    );

    const legacyFiles = new Map<number, LegacyFileHints>();
    for (const r of result.recordset) {
      const id = toId(r.serviceInvoiceId);
      const clientId = toId(r.clientId);
      if (id == null || clientId == null || !invoiceById.has(id)) continue;
      const pdfs = splitPdfFilenames(asString(r.fileName));
      legacyFiles.set(id, {
        clientId,
        annexureXlsx: asString(r.annexureFileName),
        annexurePdf: pdfs.annexurePdf,
        invoicePdf: pdfs.invoicePdf,
      });
    }

    const existing = await loadExistingDocKeys(pgPool, [...invoiceById.keys()]);

    // Legacy annexure xlsx → R2
    const legacyAnnexureDir = env.LEGACY_SERVICE_INVOICE_ANNEXURE_DIR?.trim();
    if (!legacyAnnexureDir) {
      console.warn(
        "LEGACY_SERVICE_INVOICE_ANNEXURE_DIR unset — skipping legacy annexure xlsx upload to R2.",
      );
    } else {
      try {
        const {
          persistServiceInvoiceAnnexure,
          readLegacyServiceInvoiceFile,
        } = await import("../../lib/service-invoices/annexure-r2.js");

        const client = await pgPool.connect();
        try {
          let uploaded = 0;
          let missingFile = 0;
          let uploadError = 0;
          let candidates = 0;
          for (const [id, hints] of legacyFiles) {
            if (
              hasDoc(
                existing,
                id,
                SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
              ) ||
              !hints.annexureXlsx
            ) {
              continue;
            }
            candidates++;
            try {
              const buffer = await readLegacyServiceInvoiceFile(
                legacyAnnexureDir,
                hints.annexureXlsx,
              );
              if (!buffer.length) {
                missingFile++;
                continue;
              }
              const stored = await persistServiceInvoiceAnnexure({
                invoiceId: id,
                clientId: hints.clientId,
                buffer,
              });
              await upsertDocument(client, {
                serviceInvoiceId: id,
                documentTypeId: SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
                fileName: stored.filename,
                s3Key: stored.s3Key,
              });
              existing.set(
                `${id}:${SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX}`,
                true,
              );
              uploaded++;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (isMissingFileError(msg)) {
                missingFile++;
              } else {
                uploadError++;
                console.warn(
                  `Legacy annexure xlsx R2 failed id=${id} file=${hints.annexureXlsx}: ${msg}`,
                );
              }
            }
          }
          console.log(
            `Legacy annexure xlsx R2 upload: ${uploaded} uploaded, ${missingFile} missing file, ${uploadError} errors, ${candidates} candidates (dir=${legacyAnnexureDir}).`,
          );
        } finally {
          client.release();
        }
      } catch (err) {
        console.warn(
          "Legacy annexure xlsx R2 upload skipped:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Legacy PDF files (FileName split) → R2
    const legacyPdfDir = env.LEGACY_SERVICE_INVOICE_PDF_DIR?.trim();
    if (!legacyPdfDir) {
      console.warn(
        "LEGACY_SERVICE_INVOICE_PDF_DIR unset — skipping legacy PDF upload to R2.",
      );
    } else {
      try {
        const {
          persistServiceInvoicePdf,
          readLegacyServiceInvoiceFile,
        } = await import("../../lib/service-invoices/annexure-r2.js");

        const client = await pgPool.connect();
        try {
          let annexureUploaded = 0;
          let invoiceUploaded = 0;
          let missingFile = 0;
          let uploadError = 0;
          let candidates = 0;
          for (const [id, hints] of legacyFiles) {
            if (
              !hasDoc(
                existing,
                id,
                SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
              ) &&
              hints.annexurePdf
            ) {
              candidates++;
              try {
                const buffer = await readLegacyServiceInvoiceFile(
                  legacyPdfDir,
                  hints.annexurePdf,
                );
                if (!buffer.length) {
                  missingFile++;
                } else {
                  const stored = await persistServiceInvoicePdf({
                    kind: "annexure",
                    invoiceId: id,
                    clientId: hints.clientId,
                    buffer,
                  });
                  await upsertDocument(client, {
                    serviceInvoiceId: id,
                    documentTypeId:
                      SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
                    fileName: stored.filename,
                    s3Key: stored.s3Key,
                  });
                  existing.set(
                    `${id}:${SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF}`,
                    true,
                  );
                  annexureUploaded++;
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (isMissingFileError(msg)) {
                  missingFile++;
                } else {
                  uploadError++;
                  console.warn(
                    `Legacy annexure PDF R2 failed id=${id} file=${hints.annexurePdf}: ${msg}`,
                  );
                }
              }
            }

            if (
              !hasDoc(
                existing,
                id,
                SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
              ) &&
              hints.invoicePdf
            ) {
              candidates++;
              try {
                const buffer = await readLegacyServiceInvoiceFile(
                  legacyPdfDir,
                  hints.invoicePdf,
                );
                if (!buffer.length) {
                  missingFile++;
                } else {
                  const stored = await persistServiceInvoicePdf({
                    kind: "invoice",
                    invoiceId: id,
                    clientId: hints.clientId,
                    buffer,
                  });
                  await upsertDocument(client, {
                    serviceInvoiceId: id,
                    documentTypeId:
                      SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
                    fileName: stored.filename,
                    s3Key: stored.s3Key,
                  });
                  existing.set(
                    `${id}:${SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF}`,
                    true,
                  );
                  invoiceUploaded++;
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (isMissingFileError(msg)) {
                  missingFile++;
                } else {
                  uploadError++;
                  console.warn(
                    `Legacy invoice PDF R2 failed id=${id} file=${hints.invoicePdf}: ${msg}`,
                  );
                }
              }
            }
          }
          console.log(
            `Legacy PDF R2 upload: annexure=${annexureUploaded}, invoice=${invoiceUploaded}, missing=${missingFile}, errors=${uploadError}, candidates=${candidates} (dir=${legacyPdfDir}).`,
          );
        } finally {
          client.release();
        }
      } catch (err) {
        console.warn(
          "Legacy PDF R2 upload skipped:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Auto annexure xlsx R2 backfill for rows still without type-1 document
    try {
      const { fetchAutoAnnexureLines } = await import(
        "../../services/service-invoice-annexure.service.js"
      );
      const { buildServiceInvoiceAnnexureXlsxFromLines } = await import(
        "../../lib/service-invoices/annexure-template.js"
      );
      const { persistServiceInvoiceAnnexure } = await import(
        "../../lib/service-invoices/annexure-r2.js"
      );

      const client = await pgPool.connect();
      try {
        const candidates = pgInvoices.rows.filter(
          (row) =>
            row.type === "auto" &&
            row.service_fee_type !== "fixed_amount" &&
            !hasDoc(
              existing,
              row.id,
              SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
            ),
        );
        let backfilled = 0;
        let skippedEmpty = 0;
        for (const row of candidates) {
          const resultAnnexure = await fetchAutoAnnexureLines({
            clientId: row.client_id,
            plantLocationId: row.plant_location_id,
            fromDate: row.from_date,
            toDate: row.to_date,
          });
          if (resultAnnexure.lines.length === 0) {
            skippedEmpty++;
            continue;
          }
          const buffer = await buildServiceInvoiceAnnexureXlsxFromLines(
            resultAnnexure.lines,
          );
          const stored = await persistServiceInvoiceAnnexure({
            invoiceId: row.id,
            clientId: row.client_id,
            buffer,
          });
          await upsertDocument(client, {
            serviceInvoiceId: row.id,
            documentTypeId: SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
            fileName: stored.filename,
            s3Key: stored.s3Key,
          });
          existing.set(
            `${row.id}:${SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX}`,
            true,
          );
          backfilled++;
        }
        console.log(
          `Auto annexure xlsx R2 backfill: ${backfilled} uploaded, ${skippedEmpty} skipped (no lifting in period), ${candidates.length} candidates.`,
        );
      } finally {
        client.release();
      }
    } catch (err) {
      console.warn(
        "Auto annexure R2 backfill skipped (R2/lifting unavailable):",
        err instanceof Error ? err.message : err,
      );
    }

    console.log(
      `seed:service-invoice-documents finished in ${Date.now() - started}ms.`,
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

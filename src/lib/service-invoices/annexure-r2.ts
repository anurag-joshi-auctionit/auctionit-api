import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteObject,
  getObjectBuffer,
  getSignedDownloadUrl,
  putObject,
} from "../r2.js";
import {
  buildServiceInvoiceAnnexureFilename,
  buildServiceInvoiceAnnexurePdfFilename,
  buildServiceInvoiceAnnexurePdfS3Key,
  buildServiceInvoiceAnnexureS3Key,
  buildServiceInvoiceInvoicePdfFilename,
  buildServiceInvoiceInvoicePdfS3Key,
  SI_ANNEXURE_XLSX_CONTENT_TYPE,
  SI_PDF_CONTENT_TYPE,
} from "./annexure-r2-keys.js";

export {
  buildServiceInvoiceAnnexureFilename,
  buildServiceInvoiceAnnexureS3Key,
};

export async function uploadServiceInvoiceAnnexureBuffer(opts: {
  key: string;
  buffer: Buffer;
}): Promise<void> {
  await putObject({
    key: opts.key,
    body: opts.buffer,
    contentType: SI_ANNEXURE_XLSX_CONTENT_TYPE,
  });
}

/**
 * Write annexure under a stable key (overwrites prior object for same invoice+client).
 */
export async function persistServiceInvoiceAnnexure(opts: {
  invoiceId: number;
  clientId: number;
  buffer: Buffer;
  /** Prior key to delete when clientId (or naming) changed. */
  previousS3Key?: string | null;
}): Promise<{ s3Key: string; filename: string }> {
  const s3Key = buildServiceInvoiceAnnexureS3Key({
    invoiceId: opts.invoiceId,
    clientId: opts.clientId,
  });
  const filename = buildServiceInvoiceAnnexureFilename({
    invoiceId: opts.invoiceId,
    clientId: opts.clientId,
  });

  await uploadServiceInvoiceAnnexureBuffer({
    key: s3Key,
    buffer: opts.buffer,
  });

  await deletePreviousObjectIfDifferent(opts.previousS3Key, s3Key);

  return { s3Key, filename };
}

export async function persistServiceInvoicePdf(opts: {
  kind: "annexure" | "invoice";
  invoiceId: number;
  clientId: number;
  buffer: Buffer;
  /** Prior key to delete when clientId (or naming) changed. */
  previousS3Key?: string | null;
}): Promise<{ s3Key: string; filename: string }> {
  const s3Key =
    opts.kind === "annexure"
      ? buildServiceInvoiceAnnexurePdfS3Key({
          invoiceId: opts.invoiceId,
          clientId: opts.clientId,
        })
      : buildServiceInvoiceInvoicePdfS3Key({
          invoiceId: opts.invoiceId,
          clientId: opts.clientId,
        });
  const filename =
    opts.kind === "annexure"
      ? buildServiceInvoiceAnnexurePdfFilename({
          invoiceId: opts.invoiceId,
          clientId: opts.clientId,
        })
      : buildServiceInvoiceInvoicePdfFilename({
          invoiceId: opts.invoiceId,
          clientId: opts.clientId,
        });

  await putObject({
    key: s3Key,
    body: opts.buffer,
    contentType: SI_PDF_CONTENT_TYPE,
  });

  await deletePreviousObjectIfDifferent(opts.previousS3Key, s3Key);

  return { s3Key, filename };
}

async function deletePreviousObjectIfDifferent(
  previousS3Key: string | null | undefined,
  nextS3Key: string,
): Promise<void> {
  const prev = previousS3Key?.trim();
  if (!prev || prev === nextS3Key) return;
  try {
    await deleteObject(prev);
  } catch {
    // Best-effort cleanup of orphaned keys after client/key change.
  }
}

export async function readServiceInvoiceAnnexureBuffer(
  s3Key: string,
): Promise<Buffer> {
  return getObjectBuffer(s3Key);
}

export async function signedServiceInvoiceAnnexureUrl(
  s3Key: string,
  opts?: { disposition?: "inline" | "attachment"; contentType?: string },
): Promise<string> {
  const disposition = opts?.disposition ?? "attachment";
  const filename = s3Key.split("/").pop() ?? "file";
  return getSignedDownloadUrl(s3Key, {
    contentDisposition: `${disposition}; filename="${filename}"`,
    contentType: opts?.contentType,
  });
}

const LEGACY_HTTP_FETCH_TIMEOUT_MS = 15_000;

function isHttpRoot(root: string): boolean {
  return /^https?:\/\//i.test(root);
}

export function joinLegacyServiceInvoicePath(
  root: string,
  fileName: string,
): string {
  if (isHttpRoot(root)) {
    return `${root.replace(/\/+$/, "")}/${fileName}`;
  }
  return join(root, fileName);
}

/** Read a legacy SI file from local disk or HTTP root. */
export async function readLegacyServiceInvoiceFile(
  root: string,
  fileName: string,
): Promise<Buffer> {
  const path = joinLegacyServiceInvoicePath(root, fileName);
  if (isHttpRoot(root)) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      LEGACY_HTTP_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${path}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
  await access(path);
  return readFile(path);
}

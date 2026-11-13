import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { deleteObject, getSignedDownloadUrl, putObject } from "../r2.js";
import {
  buildSubscriptionInvoicePdfFilename,
  buildSubscriptionInvoicePdfS3Key,
  SUBSCRIPTION_PDF_CONTENT_TYPE,
} from "./invoice-r2-keys.js";

const LEGACY_HTTP_FETCH_TIMEOUT_MS = 15_000;

function isHttpRoot(root: string): boolean {
  return /^https?:\/\//i.test(root);
}

export function joinLegacySubscriptionInvoicePath(
  root: string,
  fileName: string,
): string {
  if (isHttpRoot(root)) {
    return `${root.replace(/\/+$/, "")}/${fileName}`;
  }
  return join(root, fileName);
}

/** Read a legacy subscription invoice PDF from local disk or HTTP root. */
export async function readLegacySubscriptionInvoiceFile(
  root: string,
  fileName: string,
): Promise<Buffer> {
  const path = joinLegacySubscriptionInvoicePath(root, fileName);
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

export async function persistSubscriptionInvoicePdf(opts: {
  subscriptionId: number;
  bidderId: number;
  buffer: Buffer;
  previousS3Key?: string | null;
}): Promise<{ s3Key: string; filename: string }> {
  const s3Key = buildSubscriptionInvoicePdfS3Key({
    subscriptionId: opts.subscriptionId,
    bidderId: opts.bidderId,
  });
  const filename = buildSubscriptionInvoicePdfFilename({
    subscriptionId: opts.subscriptionId,
    bidderId: opts.bidderId,
  });

  await putObject({
    key: s3Key,
    body: opts.buffer,
    contentType: SUBSCRIPTION_PDF_CONTENT_TYPE,
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
    // Best-effort cleanup of orphaned keys after key change.
  }
}

export async function signedSubscriptionInvoicePdfUrl(
  s3Key: string,
  opts?: { disposition?: "inline" | "attachment" },
): Promise<string> {
  const disposition = opts?.disposition ?? "inline";
  const filename = s3Key.split("/").pop() ?? "subscription-invoice.pdf";
  return getSignedDownloadUrl(s3Key, {
    contentDisposition: `${disposition}; filename="${filename}"`,
    contentType: SUBSCRIPTION_PDF_CONTENT_TYPE,
  });
}

import { extname } from "node:path";

export const LEGACY_CLIENT_DOCUMENT_TYPE_PREFIXES: Record<number, string> = {
  1: "agreement_",
  2: "tnc_",
};

export function legacyClientDocumentTypePrefix(
  documentTypeId: number,
): string {
  return LEGACY_CLIENT_DOCUMENT_TYPE_PREFIXES[documentTypeId] ?? "document_";
}

export function clientDocumentFileNameHasPrefix(
  fileName: string,
  prefix: string,
): boolean {
  if (!fileName || !prefix) return false;
  return fileName.toLowerCase().startsWith(prefix.toLowerCase());
}

/** R2 / CDN storage name: `{prefix}{clientId}.{ext}` — later uploads overwrite the same key. */
export function buildClientR2StorageFileName(opts: {
  prefix: string;
  clientId: number;
  originalFileName: string;
}): string {
  const ext = extname(opts.originalFileName).toLowerCase() || ".bin";
  const prefix = opts.prefix.endsWith("_") ? opts.prefix : `${opts.prefix}_`;
  return `${prefix}${opts.clientId}${ext}`;
}

/**
 * UTC Unix epoch milliseconds as a numeric string — compact, sortable, timezone-safe.
 * e.g. `1782719623402`
 */
export function clientDocumentEpochMs(date: Date = new Date()): string {
  return date.getTime().toString();
}

/**
 * Standard storage pattern: `{prefix}{clientId}_{epochMs}{ext}`
 * e.g. `agreement_6059_1782719623402.pdf`
 */
export function buildClientDocumentFileName(opts: {
  prefix: string;
  clientId: number;
  uniquePart: string;
  originalFileName: string;
}): string {
  const ext = extname(opts.originalFileName).toLowerCase() || ".bin";
  const prefix = opts.prefix.endsWith("_") ? opts.prefix : `${opts.prefix}_`;
  return `${prefix}${opts.clientId}_${opts.uniquePart}${ext}`;
}

/** New upload / seed storage name — UTC epoch-ms unique part. */
export function buildNewClientDocumentFileName(opts: {
  prefix: string;
  clientId: number;
  originalFileName: string;
  at?: Date;
}): string {
  return buildClientDocumentFileName({
    prefix: opts.prefix,
    clientId: opts.clientId,
    uniquePart: clientDocumentEpochMs(opts.at ?? new Date()),
    originalFileName: opts.originalFileName,
  });
}

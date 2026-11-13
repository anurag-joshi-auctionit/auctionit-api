import {
  buildClientR2StorageFileName,
  buildNewClientDocumentFileName,
} from "./client-document-naming.js";
import {
  clientR2ObjectKey,
  clientR2ObjectKeyForDocument,
  contentTypeForClientFileName,
  sanitizeClientR2FileName,
} from "./client-r2-keys.js";
import { putObject } from "./r2.js";

export type ClientDocumentUploadResult = {
  storageFileName: string;
  filename: string;
  s3Key: string;
};

/** Legacy overwrite-style key — used only where a stable per-type key is required. */
export function resolveClientDocumentStorage(opts: {
  prefix: string;
  clientId: number;
  originalFileName: string;
}): ClientDocumentUploadResult {
  const storageFileName = buildClientR2StorageFileName({
    prefix: opts.prefix,
    clientId: opts.clientId,
    originalFileName: opts.originalFileName,
  });
  const filename = sanitizeClientR2FileName(storageFileName);
  const s3Key = clientR2ObjectKeyForDocument({
    prefix: opts.prefix,
    clientId: opts.clientId,
    originalFileName: opts.originalFileName,
  });
  return { storageFileName, filename, s3Key };
}

export function resolveClientDocumentStorageFileName(
  storageFileName: string,
): ClientDocumentUploadResult {
  const filename = sanitizeClientR2FileName(storageFileName);
  const s3Key = clientR2ObjectKey(filename);
  return { storageFileName: filename, filename, s3Key };
}

/** Live uploads — unique epoch-ms filename per upload. */
export function resolveNewClientDocumentStorage(opts: {
  prefix: string;
  clientId: number;
  originalFileName: string;
  at?: Date;
}): ClientDocumentUploadResult {
  const storageFileName = buildNewClientDocumentFileName({
    prefix: opts.prefix,
    clientId: opts.clientId,
    originalFileName: opts.originalFileName,
    at: opts.at,
  });
  return resolveClientDocumentStorageFileName(storageFileName);
}

export async function uploadClientDocumentBytesToR2(opts: {
  buffer: Buffer;
  resolved: ClientDocumentUploadResult;
}): Promise<ClientDocumentUploadResult> {
  await putObject({
    key: opts.resolved.s3Key,
    body: opts.buffer,
    contentType: contentTypeForClientFileName(opts.resolved.storageFileName),
  });

  return opts.resolved;
}

export async function uploadNewClientDocumentBytesToR2(opts: {
  buffer: Buffer;
  prefix: string;
  clientId: number;
  originalFileName: string;
  at?: Date;
}): Promise<ClientDocumentUploadResult> {
  const resolved = resolveNewClientDocumentStorage(opts);
  return uploadClientDocumentBytesToR2({ buffer: opts.buffer, resolved });
}

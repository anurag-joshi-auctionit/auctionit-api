import { extname } from "node:path";
import { buildClientR2StorageFileName } from "./client-document-naming.js";

/** Images + office documents only — no video, audio, or archives. */
export const CLIENT_DOCUMENT_ALLOWED_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
] as const;

export type ClientDocumentAllowedExtension =
  (typeof CLIENT_DOCUMENT_ALLOWED_EXTENSIONS)[number];

export function getClientDocumentExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export function isAllowedClientDocumentExtension(filename: string): boolean {
  const ext = getClientDocumentExtension(filename);
  return (CLIENT_DOCUMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

export function clientDocumentAcceptAttribute(): string {
  return CLIENT_DOCUMENT_ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",");
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Strip path segments from a storage file name. */
export function sanitizeClientR2FileName(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  if (!base || base === "." || base === "..") {
    throw new Error(`Invalid client file name: ${fileName}`);
  }
  return base;
}

/** Flat CDN layout: `clients/{storageFileName}`. */
export function clientR2ObjectKey(storageFileName: string): string {
  return `clients/${sanitizeClientR2FileName(storageFileName)}`;
}

export function clientR2ObjectKeyForDocument(opts: {
  prefix: string;
  clientId: number;
  originalFileName: string;
}): string {
  return clientR2ObjectKey(
    buildClientR2StorageFileName({
      prefix: opts.prefix,
      clientId: opts.clientId,
      originalFileName: opts.originalFileName,
    }),
  );
}

export function contentTypeForClientFileName(fileName: string): string {
  const ext = extname(sanitizeClientR2FileName(fileName)).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

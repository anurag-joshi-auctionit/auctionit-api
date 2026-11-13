import { extname } from "node:path";
import { buildBidderR2StorageFileName } from "./bidder-document-naming.js";

/** Images + office documents only — no video, audio, or archives. */
export const BIDDER_DOCUMENT_ALLOWED_EXTENSIONS = [
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

export type BidderDocumentAllowedExtension =
  (typeof BIDDER_DOCUMENT_ALLOWED_EXTENSIONS)[number];

export function getBidderDocumentExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export function isAllowedBidderDocumentExtension(filename: string): boolean {
  const ext = getBidderDocumentExtension(filename);
  return (BIDDER_DOCUMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

export function bidderDocumentAcceptAttribute(): string {
  return BIDDER_DOCUMENT_ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",");
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
export function sanitizeBidderR2FileName(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  if (!base || base === "." || base === "..") {
    throw new Error(`Invalid bidder file name: ${fileName}`);
  }
  return base;
}

/** Flat CDN layout: `bidders/{storageFileName}`. */
export function bidderR2ObjectKey(storageFileName: string): string {
  return `bidders/${sanitizeBidderR2FileName(storageFileName)}`;
}

export function bidderR2ObjectKeyForDocument(opts: {
  prefix: string;
  bidderId: number;
  originalFileName: string;
}): string {
  return bidderR2ObjectKey(
    buildBidderR2StorageFileName({
      prefix: opts.prefix,
      bidderId: opts.bidderId,
      originalFileName: opts.originalFileName,
    }),
  );
}

export function contentTypeForBidderFileName(fileName: string): string {
  const ext = extname(sanitizeBidderR2FileName(fileName)).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

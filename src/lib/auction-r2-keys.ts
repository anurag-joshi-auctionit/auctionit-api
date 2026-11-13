import { extname } from "node:path";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import {
  AUCTION_DOCUMENT_TYPE_CATALOGUE,
  AUCTION_DOCUMENT_TYPE_TNC,
} from "../db/schema/auction-documents.js";
import {
  buildAuctionDocumentFileName,
  buildCatalogueFileName,
  buildTncFileName,
} from "./auction-document-naming.js";

export const AUCTION_DOCUMENT_ALLOWED_EXTENSIONS = ["pdf", "docx"] as const;
export const MAX_AUCTION_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_AUCTION_DOCUMENT_MB = 5;

/** @deprecated Use AUCTION_DOCUMENT_ALLOWED_EXTENSIONS */
export const AUCTION_CATALOGUE_ALLOWED_EXTENSIONS =
  AUCTION_DOCUMENT_ALLOWED_EXTENSIONS;

export function sanitizeAuctionR2FileName(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  if (!base || base === "." || base === "..") {
    throw new Error(`Invalid auction file name: ${fileName}`);
  }
  return base;
}

export function auctionDocumentR2Folder(documentTypeId: number): string {
  if (documentTypeId === AUCTION_DOCUMENT_TYPE_CATALOGUE) {
    return "auctions/catalogues";
  }
  if (documentTypeId === AUCTION_DOCUMENT_TYPE_TNC) {
    return "auctions/tnc";
  }
  return "auctions/documents";
}

export function auctionDocumentR2ObjectKey(
  documentTypeId: number,
  storageFileName: string,
): string {
  return `${auctionDocumentR2Folder(documentTypeId)}/${sanitizeAuctionR2FileName(storageFileName)}`;
}

export function auctionCatalogueR2ObjectKey(storageFileName: string): string {
  return auctionDocumentR2ObjectKey(
    AUCTION_DOCUMENT_TYPE_CATALOGUE,
    storageFileName,
  );
}

export function auctionTncR2ObjectKey(storageFileName: string): string {
  return auctionDocumentR2ObjectKey(AUCTION_DOCUMENT_TYPE_TNC, storageFileName);
}

/** @deprecated Use auctionTncR2ObjectKey */
export function clientTncR2ObjectKey(storageFileName: string): string {
  return auctionTncR2ObjectKey(storageFileName);
}

export function resolveCatalogueStorage(opts: {
  auctionId: number;
  clientId: number;
  originalFileName: string;
}): { filename: string; s3Key: string } {
  const filename = sanitizeAuctionR2FileName(
    buildCatalogueFileName({
      auctionId: opts.auctionId,
      clientId: opts.clientId,
      originalFileName: opts.originalFileName,
    }),
  );
  return { filename, s3Key: auctionCatalogueR2ObjectKey(filename) };
}

export function resolveTncStorage(opts: {
  auctionId: number;
  clientId: number;
  originalFileName: string;
}): { filename: string; s3Key: string } {
  const filename = sanitizeAuctionR2FileName(
    buildTncFileName({
      auctionId: opts.auctionId,
      clientId: opts.clientId,
      originalFileName: opts.originalFileName,
    }),
  );
  return { filename, s3Key: auctionTncR2ObjectKey(filename) };
}

export function resolveAuctionDocumentStorage(opts: {
  documentTypeId: number;
  fileNamePrefix: string;
  auctionId: number;
  clientId: number;
  originalFileName: string;
}): { filename: string; s3Key: string } {
  const filename = sanitizeAuctionR2FileName(
    buildAuctionDocumentFileName({
      prefix: opts.fileNamePrefix,
      auctionId: opts.auctionId,
      clientId: opts.clientId,
      originalFileName: opts.originalFileName,
    }),
  );
  return {
    filename,
    s3Key: auctionDocumentR2ObjectKey(opts.documentTypeId, filename),
  };
}

export function contentTypeForAuctionDocument(fileName: string): string {
  const ext = extname(sanitizeAuctionR2FileName(fileName)).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}

/** @deprecated Use contentTypeForAuctionDocument */
export function contentTypeForAuctionPdf(fileName: string): string {
  return contentTypeForAuctionDocument(fileName);
}

export function isAllowedAuctionDocumentFileName(fileName: string): boolean {
  const ext = extname(fileName).toLowerCase().replace(".", "");
  return (AUCTION_DOCUMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(
    ext,
  );
}

/** @deprecated Use isAllowedAuctionDocumentFileName */
export function isAllowedCatalogueFileName(fileName: string): boolean {
  return isAllowedAuctionDocumentFileName(fileName);
}

export type AuctionDocumentKind = "pdf" | "docx";

export function sniffAuctionDocumentKind(
  buffer: Buffer,
): AuctionDocumentKind | null {
  if (buffer.length < 4) return null;
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return "pdf";
  }
  // DOCX is a ZIP (PK..) package
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const probe = buffer.subarray(0, Math.min(buffer.length, 8192)).toString("latin1");
    if (probe.includes("[Content_Types].xml") || probe.includes("word/")) {
      return "docx";
    }
  }
  return null;
}

export function assertAuctionDocumentFile(
  fileName: string,
  buffer: Buffer,
): AuctionDocumentKind {
  if (!buffer.length) {
    throw new Error(AuctionsValidationMessages.DOCUMENT_FILE_EMPTY);
  }
  if (buffer.length > MAX_AUCTION_DOCUMENT_BYTES) {
    throw new Error(
      AuctionsValidationMessages.DOCUMENT_FILE_TOO_LARGE(MAX_AUCTION_DOCUMENT_MB),
    );
  }
  if (!isAllowedAuctionDocumentFileName(fileName)) {
    throw new Error(AuctionsValidationMessages.DOCUMENT_FILE_INVALID);
  }
  const kind = sniffAuctionDocumentKind(buffer);
  if (!kind) {
    throw new Error(AuctionsValidationMessages.DOCUMENT_FILE_CONTENT_INVALID);
  }
  const ext = extname(fileName).toLowerCase().replace(".", "");
  if (ext !== kind) {
    throw new Error(
      AuctionsValidationMessages.DOCUMENT_FILE_EXTENSION_MISMATCH(ext, kind),
    );
  }
  return kind;
}

export function extensionForAuctionDocumentKind(
  kind: AuctionDocumentKind,
): string {
  return kind === "pdf" ? ".pdf" : ".docx";
}

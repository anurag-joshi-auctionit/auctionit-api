import { extname } from "node:path";
import {
  AUCTION_DOCUMENT_TYPE_CATALOGUE,
  AUCTION_DOCUMENT_TYPE_TNC,
} from "../db/schema/auction-documents.js";

export const LEGACY_AUCTION_DOCUMENT_TYPE_PREFIXES: Record<number, string> = {
  [AUCTION_DOCUMENT_TYPE_CATALOGUE]: "catalogue_",
  [AUCTION_DOCUMENT_TYPE_TNC]: "tnc_",
};

export function legacyAuctionDocumentTypePrefix(
  documentTypeId: number,
): string {
  return LEGACY_AUCTION_DOCUMENT_TYPE_PREFIXES[documentTypeId] ?? "document_";
}

/**
 * Stable 1:1 storage name per auction + document type.
 * Later uploads overwrite the same key: `{prefix}{auctionId}_{clientId}{ext}`
 * e.g. `catalogue_123_456.pdf`
 */
export function buildAuctionDocumentFileName(opts: {
  prefix: string;
  auctionId: number;
  clientId: number;
  originalFileName: string;
}): string {
  const ext = extname(opts.originalFileName).toLowerCase() || ".pdf";
  const prefix = opts.prefix.endsWith("_") ? opts.prefix : `${opts.prefix}_`;
  return `${prefix}${opts.auctionId}_${opts.clientId}${ext}`;
}

/** @deprecated Use buildAuctionDocumentFileName with catalogue_ prefix */
export function buildCatalogueFileName(opts: {
  auctionId: number;
  clientId: number;
  originalFileName: string;
}): string {
  return buildAuctionDocumentFileName({
    ...opts,
    prefix: "catalogue_",
  });
}

/** @deprecated Use buildAuctionDocumentFileName with tnc_ prefix */
export function buildTncFileName(opts: {
  auctionId: number;
  clientId: number;
  originalFileName: string;
}): string {
  return buildAuctionDocumentFileName({
    ...opts,
    prefix: "tnc_",
  });
}

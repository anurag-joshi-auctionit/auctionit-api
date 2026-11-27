import {
  buildBidderR2StorageFileName,
  buildNewBidderDocumentFileName,
} from "./bidder-document-naming.js";
import {
  bidderR2ObjectKey,
  bidderR2ObjectKeyForDocument,
  sanitizeBidderR2FileName,
} from "./bidder-r2-keys.js";

export type BidderDocumentUploadResult = {
  storageFileName: string;
  filename: string;
  s3Key: string;
};

/** Legacy overwrite-style key — used only where a stable per-type key is required. */
export function resolveBidderDocumentStorage(opts: {
  prefix: string;
  bidderId: number;
  originalFileName: string;
}): BidderDocumentUploadResult {
  const storageFileName = buildBidderR2StorageFileName({
    prefix: opts.prefix,
    bidderId: opts.bidderId,
    originalFileName: opts.originalFileName,
  });
  const filename = sanitizeBidderR2FileName(storageFileName);
  const s3Key = bidderR2ObjectKeyForDocument({
    prefix: opts.prefix,
    bidderId: opts.bidderId,
    originalFileName: opts.originalFileName,
  });
  return { storageFileName, filename, s3Key };
}

export function resolveBidderDocumentStorageFileName(
  storageFileName: string,
): BidderDocumentUploadResult {
  const filename = sanitizeBidderR2FileName(storageFileName);
  const s3Key = bidderR2ObjectKey(filename);
  return { storageFileName: filename, filename, s3Key };
}

/** Live uploads — unique epoch-ms filename per upload. */
export function resolveNewBidderDocumentStorage(opts: {
  prefix: string;
  bidderId: number;
  originalFileName: string;
  at?: Date;
}): BidderDocumentUploadResult {
  const storageFileName = buildNewBidderDocumentFileName({
    prefix: opts.prefix,
    bidderId: opts.bidderId,
    originalFileName: opts.originalFileName,
    at: opts.at,
  });
  return resolveBidderDocumentStorageFileName(storageFileName);
}


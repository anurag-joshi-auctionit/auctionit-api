import { deleteObject, putObject } from "../r2.js";
import {
  buildLotConfirmationPdfFilename,
  buildLotConfirmationPdfS3Key,
  LOT_CONFIRMATION_PDF_CONTENT_TYPE,
} from "./lot-confirmation-r2-keys.js";

export async function persistLotConfirmationPdf(opts: {
  auctionId: number;
  bidderId: number;
  buffer: Buffer;
  previousS3Key?: string | null;
}): Promise<{ s3Key: string; filename: string }> {
  const s3Key = buildLotConfirmationPdfS3Key({
    auctionId: opts.auctionId,
    bidderId: opts.bidderId,
  });
  const filename = buildLotConfirmationPdfFilename({
    auctionId: opts.auctionId,
    bidderId: opts.bidderId,
  });

  await putObject({
    key: s3Key,
    body: opts.buffer,
    contentType: LOT_CONFIRMATION_PDF_CONTENT_TYPE,
  });

  await deletePreviousObjectIfDifferent(opts.previousS3Key, s3Key);

  return { s3Key, filename };
}

export async function deleteLotConfirmationPdf(s3Key: string): Promise<void> {
  try {
    await deleteObject(s3Key);
  } catch {
    // Best-effort cleanup when the winner has no remaining approved lots.
  }
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
    // Best-effort cleanup of orphaned keys after a naming change.
  }
}

import { contentTypeForAuctionDocument } from "./auction-r2-keys.js";
import { objectExists, putObject } from "./r2.js";

export async function uploadAuctionDocumentBytesToR2(opts: {
  s3Key: string;
  buffer: Buffer;
  filename: string;
}): Promise<void> {
  await putObject({
    key: opts.s3Key,
    body: opts.buffer,
    contentType: contentTypeForAuctionDocument(opts.filename),
  });

  const exists = await objectExists(opts.s3Key);
  if (!exists) {
    throw new Error(`R2 upload verification failed for key: ${opts.s3Key}`);
  }
}

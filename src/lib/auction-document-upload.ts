import { contentTypeForAuctionDocument } from "./auction-r2-keys.js";
import { putObject } from "./r2.js";

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
}

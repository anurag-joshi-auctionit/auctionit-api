import { randomUUID } from "node:crypto";

function extractExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export function buildRaStageFileKey(opts: {
  auctionId: number;
  stageKey: string;
  bidderId: number;
  filename: string;
}): string {
  const ext = extractExt(opts.filename);
  const uuid = randomUUID();
  return `ra-stages/${opts.auctionId}/${opts.stageKey}/${opts.bidderId}/${uuid}${ext ? `.${ext}` : ""}`;
}

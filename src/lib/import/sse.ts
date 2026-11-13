import type { Response } from "express";
import type {
  ImportProgress,
  ImportResult,
  ImportSseError,
} from "@auctionit/xlsx-import/types";

export function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type ImportSseNeedsReview = {
  stagingId: string;
  parsed: number;
  failed: number;
  skipped: number;
  total: number;
  issues: ImportResult["issues"];
  issuesTruncated?: boolean;
};

export type ImportSseWriter = {
  progress: (data: ImportProgress) => void;
  complete: <T extends ImportResult>(data: T) => void;
  needsReview: (data: ImportSseNeedsReview) => void;
  error: (data: ImportSseError) => void;
  close: () => void;
};

export function createImportSseWriter(res: Response): ImportSseWriter {
  let closed = false;

  const write = (event: string, data: unknown) => {
    if (closed) return;
    res.write(encodeSseEvent(event, data));
  };

  return {
    progress: (data) => write("progress", data),
    complete: (data) => {
      write("complete", data);
      closed = true;
      res.end();
    },
    needsReview: (data) => {
      write("needs_review", data);
      closed = true;
      res.end();
    },
    error: (data) => {
      write("error", data);
      closed = true;
      res.end();
    },
    close: () => {
      if (!closed) {
        closed = true;
        res.end();
      }
    },
  };
}

export function setImportSseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

export async function runImportSseHandler(
  res: Response,
  run: (writer: ImportSseWriter) => Promise<void>,
): Promise<void> {
  setImportSseHeaders(res);
  const writer = createImportSseWriter(res);

  try {
    await run(writer);
    if (!res.writableEnded) {
      writer.close();
    }
  } catch (e) {
    if (!res.writableEnded) {
      const message =
        e instanceof Error ? e.message : "Import failed unexpectedly.";
      writer.error({ message });
    }
  }
}

/** @deprecated Use createImportSseWriter / runImportSseHandler */
export const createLiftingClientsImportSseWriter = createImportSseWriter;
/** @deprecated Use runImportSseHandler */
export const runLiftingClientsImportSseHandler = runImportSseHandler;

export type LiftingClientsImportSseWriter = ImportSseWriter;

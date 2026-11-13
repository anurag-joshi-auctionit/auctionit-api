import { readXlsxMatrix } from "@auctionit/xlsx-import/read-xlsx";
import {
  parseAuctionLotImportSheetRows,
  type ParseAuctionLotImportSheetResult,
} from "./auction-lot-import-parse.js";

export type { ParseAuctionLotImportSheetResult };

/** Reads an XLSX buffer on the server and returns parsed / schema-validated rows. */
export async function parseAuctionLotImportXlsxBuffer(
  buffer: ArrayBuffer | Buffer,
  opts?: { auctionType?: string | null },
): Promise<ParseAuctionLotImportSheetResult> {
  const { matrix } = await readXlsxMatrix(buffer, {
    preferredSheetNames: ["ImportLayout", "lots"],
  });
  if (matrix.length === 0) {
    return { rows: [], rowErrors: [] };
  }
  return parseAuctionLotImportSheetRows(matrix, opts);
}

import { readXlsxMatrix } from "@auctionit/xlsx-import/read-xlsx";
import {
  parseLiftingClientsImportSheetRows,
  type ParseLiftingClientsImportSheetResult,
} from "./lifting-clients-import-parse.js";

export type { ParseLiftingClientsImportSheetResult };

/** Reads an XLSX buffer on the server and returns parsed / schema-validated rows. */
export async function parseLiftingClientsImportXlsxBuffer(
  buffer: ArrayBuffer | Buffer,
): Promise<ParseLiftingClientsImportSheetResult> {
  const { matrix } = await readXlsxMatrix(buffer, {
    preferredSheetNames: ["Lifting"],
  });
  if (matrix.length === 0) {
    return { rows: [], rowErrors: [], skippedIssues: [] };
  }
  return parseLiftingClientsImportSheetRows(matrix);
}

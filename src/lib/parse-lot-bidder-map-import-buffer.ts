import { readXlsxMatrix } from "@auctionit/xlsx-import/read-xlsx";
import { LOT_BIDDER_MAP_IMPORT_SHEET } from "./lot-bidder-map-import/constants.js";
import { parseLotBidderMapImportSheetRows } from "./lot-bidder-map-import/parse.js";
import type {
  LotBidderMapImportRawRow,
  ParseLotBidderMapImportSheetResult,
} from "./lot-bidder-map-import/types.js";

export type { LotBidderMapImportRawRow, ParseLotBidderMapImportSheetResult };

export async function parseLotBidderMapImportXlsxBuffer(
  buffer: ArrayBuffer | Buffer,
): Promise<ParseLotBidderMapImportSheetResult> {
  const { matrix } = await readXlsxMatrix(buffer, {
    preferredSheetNames: [LOT_BIDDER_MAP_IMPORT_SHEET],
  });
  return parseLotBidderMapImportSheetRows(matrix);
}

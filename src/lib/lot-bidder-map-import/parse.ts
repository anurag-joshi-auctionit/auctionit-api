import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import {
  buildHeaderIndexMap,
  cellByHeaderKey,
  isImportRowBlank,
} from "@auctionit/xlsx-import/headers";
import { LOT_BIDDER_MAP_IMPORT_TEMPLATE_HEADERS } from "./constants.js";
import {
  castImportCellNumber,
  coerceImportCellString,
  parseDisplayOrders,
} from "./coerce.js";
import type {
  LotBidderMapImportRawRow,
  ParseLotBidderMapImportSheetResult,
} from "./types.js";

export function parseLotBidderMapImportSheetRows(
  matrix: unknown[][],
): ParseLotBidderMapImportSheetResult {
  if (matrix.length === 0) {
    return {
      rows: [],
      headerError: AuctionsValidationMessages.LOT_BIDDER_MAP_SPREADSHEET_EMPTY,
    };
  }

  const headerRow = matrix[0] ?? [];
  const { columnIndexByKey, missingLabels } = buildHeaderIndexMap(
    headerRow,
    LOT_BIDDER_MAP_IMPORT_TEMPLATE_HEADERS,
  );

  if (missingLabels.length > 0) {
    return {
      rows: [],
      headerError: AuctionsValidationMessages.LOT_BIDDER_MAP_HEADER_MISSING(
        missingLabels.join(", "),
      ),
    };
  }

  const rows: LotBidderMapImportRawRow[] = [];

  for (let i = 1; i < matrix.length; i++) {
    const cols = matrix[i] ?? [];
    if (isImportRowBlank(cols)) continue;

    const bidderId = castImportCellNumber(
      cellByHeaderKey(cols, columnIndexByKey, "bidderId"),
    );
    const bidderName = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "bidderName"),
    );
    const lotDisplayOrdersRaw = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "lotDisplayOrders"),
    );
    const emdDisplayOrdersRaw = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "emdDisplayOrders"),
    );
    const isEmdWithClientRaw = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "isEmdWithClient"),
    );

    rows.push({
      rowNumber: i + 1,
      bidderId,
      bidderName,
      lotDisplayOrders: parseDisplayOrders(lotDisplayOrdersRaw),
      lotDisplayOrdersRaw,
      emdDisplayOrders: parseDisplayOrders(emdDisplayOrdersRaw),
      emdDisplayOrdersRaw,
      isEmdWithClientRaw,
    });
  }

  return { rows, headerError: null };
}

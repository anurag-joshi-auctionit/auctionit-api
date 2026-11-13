import {
  castImportNumber,
  coerceImportCellString,
} from "@auctionit/xlsx-import/coerce";
import {
  castImportDateTimeToIso,
  castImportTimeOfDay,
} from "@auctionit/xlsx-import/date";

export { coerceImportCellString, castImportDateTimeToIso, castImportTimeOfDay };

export function castImportQtyToNumber(raw: unknown): number | null {
  return castImportNumber(raw);
}

export function castImportPriceToNumber(raw: unknown): number | null {
  return castImportNumber(raw);
}

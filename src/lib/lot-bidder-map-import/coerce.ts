import {
  castImportNumber,
  coerceImportCellString,
  parseYesNo,
} from "@auctionit/xlsx-import/coerce";

export { coerceImportCellString, parseYesNo };

export function castImportCellNumber(value: unknown): number | null {
  return castImportNumber(value);
}

/** Parse comma-separated display orders like "1, 2.5, 3" -> [1, 2.5, 3]. */
export function parseDisplayOrders(raw: string): number[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n));
}

/** @deprecated Prefer parseYesNo from @auctionit/xlsx-import/coerce */
export function parseIsEmdWithClient(raw: string): boolean | null {
  return parseYesNo(raw);
}

function sortedOrdersKey(orders: number[]): string {
  return [...orders].sort((a, b) => a - b).join(",");
}

export type LotBidderMapDedupeSkip = {
  rowNumber: number;
  keptRowNumber: number;
};

export type DedupeLotBidderMapImportRowsResult<T> = {
  rows: T[];
  skipped: LotBidderMapDedupeSkip[];
};

/**
 * Collapse Excel rows that map the same bidder with the same lot/EMD
 * payload. Keeps the first occurrence; later exact duplicates are reported as
 * skipped (with the kept row number for messaging).
 */
export function dedupeLotBidderMapImportRows<
  T extends {
    rowNumber: number;
    bidderId: number | null;
    lotDisplayOrders: number[];
    emdDisplayOrders: number[];
    isEmdWithClientRaw: string;
  },
>(rows: T[]): DedupeLotBidderMapImportRowsResult<T> {
  const seen = new Map<string, number>();
  const out: T[] = [];
  const skipped: LotBidderMapDedupeSkip[] = [];

  for (const row of rows) {
    const key = [
      row.bidderId ?? "",
      sortedOrdersKey(row.lotDisplayOrders),
      sortedOrdersKey(row.emdDisplayOrders),
      row.isEmdWithClientRaw.trim().toLowerCase(),
    ].join("|");
    const keptRowNumber = seen.get(key);
    if (keptRowNumber != null) {
      skipped.push({ rowNumber: row.rowNumber, keptRowNumber });
      continue;
    }
    seen.set(key, row.rowNumber);
    out.push(row);
  }

  return { rows: out, skipped };
}

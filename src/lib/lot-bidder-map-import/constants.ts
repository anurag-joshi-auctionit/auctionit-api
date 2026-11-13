import type { ImportHeaderDef } from "@auctionit/xlsx-import/types";

export const LOT_BIDDER_MAP_IMPORT_SHEET = "LotBidderMap";

/** Number of data rows that receive dropdown validation in the template. */
export const LOT_BIDDER_MAP_IMPORT_TEMPLATE_DATA_ROWS = 200;

export const LOT_BIDDER_MAP_IMPORT_ROW_HEADER_KEYS = [
  "bidderId",
  "bidderName",
  "lotDisplayOrders",
  "emdDisplayOrders",
  "isEmdWithClient",
] as const;

export type LotBidderMapImportHeaderKey =
  (typeof LOT_BIDDER_MAP_IMPORT_ROW_HEADER_KEYS)[number];

export const LOT_BIDDER_MAP_IMPORT_TEMPLATE_HEADERS: ReadonlyArray<
  ImportHeaderDef<LotBidderMapImportHeaderKey>
> = [
  { key: "bidderId", label: "Bidder ID", width: 12 },
  { key: "bidderName", label: "Bidder Name", width: 50 },
  { key: "lotDisplayOrders", label: "Lot Display Orders", width: 34 },
  { key: "emdDisplayOrders", label: "EMD Display Orders", width: 34 },
  { key: "isEmdWithClient", label: "Is EMD With Client", width: 22 },
];

export const LOT_BIDDER_MAP_IMPORT_DROPDOWN_KEYS = [
  "isEmdWithClient",
] as const satisfies ReadonlyArray<LotBidderMapImportHeaderKey>;

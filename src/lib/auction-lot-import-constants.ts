import { GST_RATE_VALUES } from "@auctionit/lib/gst-rates";
import { LOADING_SCOPE_DISPLAY } from "@auctionit/lib/loading-scope";
import { bidStepLabel } from "@auctionit/lib/bid-increment-vs-price";
import type { ImportHeaderDef } from "@auctionit/xlsx-import/types";

export const AUCTION_LOT_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const AUCTION_LOT_IMPORT_MAX_ROWS = 5_000;
export const AUCTION_LOT_IMPORT_BATCH_SIZE = 50;
export const AUCTION_LOT_IMPORT_MAX_ISSUES_IN_RESPONSE = 2_000;
export const AUCTION_LOT_IMPORT_TEMPLATE_DATA_ROWS = 200;

export const AUCTION_LOT_IMPORT_SHEET = "ImportLayout";

/** Internal keys for row objects / field errors. */
export const AUCTION_LOT_IMPORT_ROW_HEADER_KEYS = [
  "displayOrder",
  "lotNumber",
  "materialLiftingDays",
  "plantLocation",
  "materialLocation",
  "startBidPrice",
  "bidIncrement",
  "bidLimit",
  "quantity",
  "uom",
  "lotStartTime",
  "lotEndTime",
  "itemId",
  "materialDescription",
  "materialName",
  "benchmarkMaterial",
  "gstPercentage",
  "tcsPercentage",
  "loadingScope",
  "remark",
] as const;

export type AuctionLotImportHeaderKey =
  (typeof AUCTION_LOT_IMPORT_ROW_HEADER_KEYS)[number];

/** Excel header defs — template writes `label`; parse matches label or legacy key. */
export function auctionLotImportTemplateHeaders(
  auctionType?: string | null,
): ReadonlyArray<ImportHeaderDef<AuctionLotImportHeaderKey>> {
  const stepLabel = bidStepLabel(auctionType);
  return [
    { key: "displayOrder", label: "Display Order", width: 14 },
    { key: "lotNumber", label: "Lot Number", width: 16 },
    { key: "materialLiftingDays", label: "Material Lifting Days", width: 18 },
    { key: "plantLocation", label: "Plant Location", width: 18 },
    { key: "materialLocation", label: "Material Location", width: 18 },
    { key: "startBidPrice", label: "Start Bid Price", width: 14 },
    {
      key: "bidIncrement",
      label: stepLabel,
      width: 20,
      aliases: [
        "Bid Step",
        "Bid Increment",
        "Bid Decrement",
        "BidIncrement/Decrement",
      ],
    },
    { key: "bidLimit", label: "Bid Limit", width: 12 },
    { key: "quantity", label: "Quantity", width: 12 },
    { key: "uom", label: "UOM", width: 10 },
    { key: "lotStartTime", label: "Lot Start Time", width: 18 },
    { key: "lotEndTime", label: "Lot End Time", width: 18 },
    { key: "itemId", label: "Item ID", width: 22 },
    { key: "materialDescription", label: "Material Description", width: 28 },
    { key: "materialName", label: "Material Name", width: 22 },
    { key: "benchmarkMaterial", label: "Benchmark Material", width: 28 },
    { key: "gstPercentage", label: "GST %", width: 10 },
    { key: "tcsPercentage", label: "TCS %", width: 10 },
    { key: "loadingScope", label: "Loading Scope", width: 14 },
    { key: "remark", label: "Remark", width: 24 },
  ];
}

/** Default (forward) headers for callers without auction type. */
export const AUCTION_LOT_IMPORT_TEMPLATE_HEADERS =
  auctionLotImportTemplateHeaders();

export const AUCTION_LOT_IMPORT_TEMPLATE_HEADER_KEYS =
  AUCTION_LOT_IMPORT_TEMPLATE_HEADERS.map((h) => h.key);

export const AUCTION_LOT_IMPORT_DROPDOWN_KEYS = [
  "plantLocation",
  "materialLocation",
  "gstPercentage",
  "loadingScope",
  "itemId",
  "uom",
  "benchmarkMaterial",
] as const;

export { GST_RATE_VALUES, LOADING_SCOPE_DISPLAY };

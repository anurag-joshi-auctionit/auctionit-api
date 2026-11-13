import type { ImportHeaderDef } from "@auctionit/xlsx-import/types";

/** Max import rows per file (scoped template size cap). */
export const LIFTING_CLIENTS_IMPORT_MAX_ROWS = 5_000;

/** Max upload file size (bytes). */
export const LIFTING_CLIENTS_IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Rows committed per internal import batch. */
export const LIFTING_CLIENTS_IMPORT_BATCH_SIZE = 25;

/** Max per-row issues returned in the API response. */
export const LIFTING_CLIENTS_IMPORT_MAX_ISSUES_IN_RESPONSE = 2_000;

export const LIFTING_CLIENTS_IMPORT_SHEET = "Lifting";

export const LIFTING_CLIENTS_IMPORT_ROW_HEADER_KEYS = [
  "lotId",
  "auctionName",
  "lotNumber",
  "approvedQty",
  "totalLiftedQty",
  "balanceQty",
  "liftedQty",
  "liftedDate",
  "dispositionStatus",
  "remarks",
] as const;

export type LiftingClientsImportTemplateHeaderKey =
  (typeof LIFTING_CLIENTS_IMPORT_ROW_HEADER_KEYS)[number];

export const LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADERS: ReadonlyArray<
  ImportHeaderDef<LiftingClientsImportTemplateHeaderKey>
> = [
  { key: "lotId", label: "Lot ID", width: 14 },
  { key: "auctionName", label: "Auction Name", width: 28 },
  { key: "lotNumber", label: "Lot Number", width: 14 },
  { key: "approvedQty", label: "Approved Qty", width: 14 },
  { key: "totalLiftedQty", label: "Total Lifted Qty", width: 16 },
  { key: "balanceQty", label: "Balance Qty", width: 14 },
  { key: "liftedQty", label: "Lifted Qty", width: 14 },
  { key: "liftedDate", label: "Lifted Date", width: 14 },
  { key: "dispositionStatus", label: "Disposition Status", width: 18 },
  { key: "remarks", label: "Remarks", width: 32 },
];

export const LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADER_KEYS =
  LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADERS.map((h) => h.key);

/** Columns users may edit in the template (1-based indices on Lifting sheet). */
export const LIFTING_CLIENTS_IMPORT_EDITABLE_COLS = [7, 8, 9, 10] as const;

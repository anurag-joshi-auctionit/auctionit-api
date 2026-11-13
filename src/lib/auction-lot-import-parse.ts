import { z } from "zod";
import { DEFAULT_LOADING_SCOPE_DISPLAY } from "@auctionit/lib/loading-scope";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import {
  buildHeaderIndexMap,
  isImportRowBlank,
} from "@auctionit/xlsx-import/headers";
import { auctionLotImportTemplateHeaders } from "./auction-lot-import-constants.js";
import {
  castImportQtyToNumber,
  castImportTimeOfDay,
  coerceImportCellString,
} from "./auction-lot-import-coerce.js";
import { auctionLotImportRowSchema, refineBidIncrementVsPrice, refineBidLimitVsStartPrice } from "./auction-lot-import-schema.js";

export type ParsedAuctionLotImportRow = {
  rowNumber: number;
  data: z.infer<typeof auctionLotImportRowSchema>;
};

export type AuctionLotImportParseRowError = {
  rowNumber: number;
  fieldErrors: Record<string, string[]>;
};

export type ParseAuctionLotImportSheetResult = {
  rows: ParsedAuctionLotImportRow[];
  rowErrors: AuctionLotImportParseRowError[];
};

function formatFieldErrors(fieldErrors: Record<string, string[]>): string {
  return Object.entries(fieldErrors)
    .flatMap(([field, messages]) =>
      messages.map((message) => `${field}: ${message}`),
    )
    .join("; ");
}

function requireNumber(
  raw: unknown,
  field: string,
  fieldErrors: Record<string, string[]>,
  opts?: { required?: boolean; integer?: boolean },
): number | null {
  const required = opts?.required !== false;
  const text = coerceImportCellString(raw);
  if (!text) {
    if (required) fieldErrors[field] = [`${field} is required`];
    return null;
  }
  const n = castImportQtyToNumber(raw);
  if (n == null) {
    fieldErrors[field] = [`${field} must be a valid number`];
    return null;
  }
  if (opts?.integer && !Number.isInteger(n)) {
    fieldErrors[field] = [`${field} must be an integer`];
    return null;
  }
  return n;
}

function castImportRowFields(
  obj: Record<string, unknown>,
  auctionType?: string | null,
):
  | { ok: true; data: z.infer<typeof auctionLotImportRowSchema> }
  | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};

  const lotNumber = coerceImportCellString(obj.lotNumber);
  if (!lotNumber) fieldErrors.lotNumber = ["Lot number is required"];

  const materialLiftingDays = requireNumber(
    obj.materialLiftingDays,
    "materialLiftingDays",
    fieldErrors,
    { required: false, integer: true },
  );
  const plantLocation = coerceImportCellString(obj.plantLocation);
  if (!plantLocation) fieldErrors.plantLocation = ["Plant location is required"];
  const materialLocation =
    coerceImportCellString(obj.materialLocation) || null;

  const gstPercentage = requireNumber(
    obj.gstPercentage,
    "gstPercentage",
    fieldErrors,
  );
  const tcsPercentage = requireNumber(
    obj.tcsPercentage,
    "tcsPercentage",
    fieldErrors,
  );
  const startBidPrice = requireNumber(
    obj.startBidPrice,
    "startBidPrice",
    fieldErrors,
  );
  const bidLimit = requireNumber(obj.bidLimit, "bidLimit", fieldErrors);
  const bidIncrement = requireNumber(
    obj.bidIncrement,
    "bidIncrement",
    fieldErrors,
  );

  const lotStartTime = castImportTimeOfDay(obj.lotStartTime);
  if (!lotStartTime) {
    fieldErrors.lotStartTime = [
      coerceImportCellString(obj.lotStartTime)
        ? AuctionsValidationMessages.LOT_TIME_INVALID
        : AuctionsValidationMessages.LOT_START_TIME_REQUIRED,
    ];
  }
  const lotEndTime = castImportTimeOfDay(obj.lotEndTime);
  if (!lotEndTime) {
    fieldErrors.lotEndTime = [
      coerceImportCellString(obj.lotEndTime)
        ? AuctionsValidationMessages.LOT_TIME_INVALID
        : AuctionsValidationMessages.LOT_END_TIME_REQUIRED,
    ];
  }

  const loadingScope =
    coerceImportCellString(obj.loadingScope) || DEFAULT_LOADING_SCOPE_DISPLAY;

  const displayOrder = requireNumber(
    obj.displayOrder,
    "displayOrder",
    fieldErrors,
  );
  const remark = coerceImportCellString(obj.remark);

  const itemRaw = obj.itemId;
  const itemText = coerceImportCellString(itemRaw);
  let itemIdNum: number | null = null;
  if (typeof itemRaw === "number" && Number.isFinite(itemRaw)) {
    itemIdNum = Math.trunc(itemRaw);
  } else if (itemText) {
    const m = itemText.match(/@@\s*(\d+)\s*$/);
    const raw = m?.[1] ?? itemText.trim();
    const n = Number(raw);
    itemIdNum = Number.isInteger(n) && n > 0 ? n : null;
  }
  if (itemIdNum == null && itemText) {
    fieldErrors.itemId = ["Item Id is invalid"];
  }

  const quantity = requireNumber(obj.quantity, "quantity", fieldErrors);
  const uom = coerceImportCellString(obj.uom);
  if (!uom) fieldErrors.uom = ["UOM is required"];

  const benchmarkMaterial =
    coerceImportCellString(obj.benchmarkMaterial) || null;

  const materialName = coerceImportCellString(obj.materialName);
  if (!materialName) fieldErrors.materialName = ["Material name is required"];

  const materialDescriptionRaw = coerceImportCellString(obj.materialDescription);

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const parsed = auctionLotImportRowSchema.safeParse({
    lotNumber,
    materialLiftingDays,
    plantLocation,
    materialLocation,
    gstPercentage,
    tcsPercentage,
    startBidPrice,
    bidLimit,
    bidIncrement,
    lotStartTime,
    lotEndTime,
    loadingScope,
    displayOrder,
    remark,
    itemId: itemIdNum,
    quantity,
    uom,
    benchmarkMaterial,
    materialName,
    materialDescription: materialDescriptionRaw || null,
  });

  if (!parsed.success) {
    const zodErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "row");
      if (!zodErrors[key]) zodErrors[key] = [];
      zodErrors[key].push(issue.message);
    }
    return { ok: false, fieldErrors: zodErrors };
  }

  const bidLimitErr = refineBidLimitVsStartPrice(parsed.data, auctionType);
  if (bidLimitErr) {
    return { ok: false, fieldErrors: { bidLimit: [bidLimitErr] } };
  }

  const bidIncrementErr = refineBidIncrementVsPrice(parsed.data, auctionType);
  if (bidIncrementErr) {
    return { ok: false, fieldErrors: { bidIncrement: [bidIncrementErr] } };
  }

  return { ok: true, data: parsed.data };
}

export function parseAuctionLotImportSheetRows(
  matrix: unknown[][],
  opts?: { auctionType?: string | null },
): ParseAuctionLotImportSheetResult {
  if (matrix.length === 0) {
    return { rows: [], rowErrors: [] };
  }

  const headerDefs = auctionLotImportTemplateHeaders(opts?.auctionType);
  const headerRow = matrix[0] ?? [];
  const { columnIndexByKey } = buildHeaderIndexMap(
    headerRow,
    headerDefs,
  );

  if (!columnIndexByKey.has("lotNumber")) {
    const lotNumberLabel =
      headerDefs.find((h) => h.key === "lotNumber")?.label ?? "Lot Number";
    return {
      rows: [],
      rowErrors: [
        {
          rowNumber: 1,
          fieldErrors: {
            lotNumber: [
              AuctionsValidationMessages.LOT_IMPORT_HEADER_MISSING(
                lotNumberLabel,
              ),
            ],
          },
        },
      ],
    };
  }

  const rows: ParsedAuctionLotImportRow[] = [];
  const rowErrors: AuctionLotImportParseRowError[] = [];
  const auctionType = opts?.auctionType ?? null;

  for (let i = 1; i < matrix.length; i++) {
    const line = matrix[i] ?? [];
    if (isImportRowBlank(line)) {
      continue;
    }

    const rowNumber = i + 1;
    const obj: Record<string, unknown> = {};
    for (const [key, colIndex] of columnIndexByKey) {
      obj[key] = line[colIndex];
    }

    const cast = castImportRowFields(obj, auctionType);
    if (!cast.ok) {
      rowErrors.push({ rowNumber, fieldErrors: cast.fieldErrors });
      continue;
    }

    rows.push({ rowNumber, data: cast.data });
  }

  return { rows, rowErrors };
}

export { formatFieldErrors };

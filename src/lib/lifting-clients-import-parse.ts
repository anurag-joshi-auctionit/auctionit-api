import { LiftingClientsValidationMessages } from "@auctionit/messages/lifting-clients";
import type { ImportRowIssue } from "@auctionit/xlsx-import/types";
import { z } from "zod";
import {
  buildHeaderIndexMap,
  isImportRowBlank,
} from "@auctionit/xlsx-import/headers";
import {
  DEFAULT_LIFTING_CLIENT_DISPOSITION_ID,
  LIFTING_CLIENT_DISPOSITION,
  LIFTING_CLIENT_DISPOSITION_LABELS,
} from "./lifting-client-status.js";
import {
  castImportDateToIso,
  isIsoDateString,
} from "./lifting-clients-import-date.js";
import {
  castImportQtyToNumber,
  castImportRemarks,
  coerceImportCellString,
  isLiftedQtyProvided,
} from "./lifting-clients-import-coerce.js";
import { LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADERS } from "./lifting-clients-import-constants.js";
import { liftingClientsImportRowSchema } from "./lifting-clients-import-schema.js";

const labelToId = new Map<string, number>(
  Object.entries(LIFTING_CLIENT_DISPOSITION_LABELS).map(([id, label]) => [
    label.trim().toLowerCase(),
    Number(id),
  ]),
);

const validDispositionIds = new Set<number>(
  Object.values(LIFTING_CLIENT_DISPOSITION),
);

export function normalizeDispositionInput(
  raw: unknown,
): number | undefined {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && validDispositionIds.has(raw)
      ? raw
      : undefined;
  }
  const trimmed = coerceImportCellString(raw);
  if (!trimmed) return undefined;
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && validDispositionIds.has(asNumber)) {
    return asNumber;
  }
  return labelToId.get(trimmed.toLowerCase());
}

export type ParsedLiftingClientsImportRow = {
  rowNumber: number;
  data: z.infer<typeof liftingClientsImportRowSchema>;
};

export type LiftingClientsImportParseRowError = {
  rowNumber: number;
  fieldErrors: Record<string, string[]>;
};

export type ParseLiftingClientsImportSheetResult = {
  rows: ParsedLiftingClientsImportRow[];
  rowErrors: LiftingClientsImportParseRowError[];
  /** Non-blank template rows with no lifted quantity — intentionally skipped. */
  skippedIssues: ImportRowIssue[];
};

function castImportRowFields(obj: Record<string, unknown>):
  | {
      ok: true;
      data: {
        lotId: string;
        auctionName: string;
        lotNumber: string;
        liftedQty: number;
        liftedDate: string;
        dispositionStatus: number;
        remarks: string;
      };
    }
  | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};

  const lotId = coerceImportCellString(obj.lotId);
  const auctionName = coerceImportCellString(obj.auctionName);
  const lotNumber = coerceImportCellString(obj.lotNumber);

  if (!lotId) {
    fieldErrors.lotId = [LiftingClientsValidationMessages.LOT_ID_REQUIRED];
  }
  if (!auctionName) {
    fieldErrors.auctionName = [
      LiftingClientsValidationMessages.AUCTION_NAME_REQUIRED,
    ];
  }
  if (!lotNumber) {
    fieldErrors.lotNumber = [
      LiftingClientsValidationMessages.LOT_NUMBER_REQUIRED,
    ];
  }

  const qtyCast = castImportQtyToNumber(obj.liftedQty);
  if (!qtyCast.ok) {
    fieldErrors.liftedQty = [qtyCast.error];
  }

  const dateCast = castImportDateToIso(obj.liftedDate);
  if (!dateCast.ok) {
    fieldErrors.liftedDate = [dateCast.error];
  } else if (!dateCast.iso) {
    fieldErrors.liftedDate = [
      LiftingClientsValidationMessages.LIFTED_DATE_REQUIRED,
    ];
  } else if (!isIsoDateString(dateCast.iso)) {
    fieldErrors.liftedDate = [
      LiftingClientsValidationMessages.LIFTED_DATE_MUST_BE_ISO,
    ];
  } else {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    if (dateCast.iso > today) {
      fieldErrors.liftedDate = [
        LiftingClientsValidationMessages.LIFTED_DATE_FUTURE,
      ];
    }
  }

  const remarksCast = castImportRemarks(obj.remarks);
  if (!remarksCast.ok) {
    fieldErrors.remarks = [remarksCast.error];
  }

  const dispositionStatus =
    normalizeDispositionInput(obj.dispositionStatus) ??
    DEFAULT_LIFTING_CLIENT_DISPOSITION_ID;

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    data: {
      lotId,
      auctionName,
      lotNumber,
      liftedQty: qtyCast.ok ? qtyCast.value : 0,
      liftedDate: dateCast.ok ? dateCast.iso : "",
      dispositionStatus,
      remarks: remarksCast.ok ? remarksCast.value : "",
    },
  };
}

export function parseLiftingClientsImportSheetRows(
  matrix: unknown[][],
): ParseLiftingClientsImportSheetResult {
  if (matrix.length < 2) {
    return { rows: [], rowErrors: [], skippedIssues: [] };
  }

  const headerRow = matrix[0] ?? [];
  const { columnIndexByKey } = buildHeaderIndexMap(
    headerRow,
    LIFTING_CLIENTS_IMPORT_TEMPLATE_HEADERS,
  );

  const rows: ParsedLiftingClientsImportRow[] = [];
  const rowErrors: LiftingClientsImportParseRowError[] = [];
  const skippedIssues: ImportRowIssue[] = [];

  for (let i = 1; i < matrix.length; i++) {
    const line = matrix[i];
    if (!line || isImportRowBlank(line)) {
      continue;
    }

    const obj: Record<string, unknown> = {};
    for (const [key, colIndex] of columnIndexByKey) {
      obj[key] = line[colIndex];
    }

    const rowNumber = i + 1;

    if (!isLiftedQtyProvided(obj.liftedQty)) {
      skippedIssues.push({
        rowNumber,
        kind: "skipped",
        reason: LiftingClientsValidationMessages.ROW_SKIPPED_NO_LIFTED_QTY,
      });
      continue;
    }

    const cast = castImportRowFields(obj);
    if (!cast.ok) {
      rowErrors.push({ rowNumber, fieldErrors: cast.fieldErrors });
      continue;
    }

    const parsed = liftingClientsImportRowSchema.safeParse(cast.data);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.join(".") || "_root";
        if (!fieldErrors[path]) fieldErrors[path] = [];
        fieldErrors[path].push(issue.message);
      }
      rowErrors.push({ rowNumber, fieldErrors });
      continue;
    }

    rows.push({ rowNumber, data: parsed.data });
  }

  return { rows, rowErrors, skippedIssues };
}

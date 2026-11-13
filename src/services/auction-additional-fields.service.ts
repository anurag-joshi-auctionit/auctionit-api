import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import {
  ADDITIONAL_FIELD_DATA_TYPE_LABELS,
  ADDITIONAL_FIELD_FORMAT_LABELS,
  ADDITIONAL_FIELD_SCOPE_LABELS,
  formatAdditionalFieldValue,
  normalizeAdditionalFieldValue,
  type AdditionalFieldDataType,
  type AdditionalFieldScope,
} from "@auctionit/messages/clients";
import { formatUtcNow } from "@auctionit/lib/date";
import {
  buildHeaderIndexMap,
  cellByHeaderKey,
  isImportRowBlank,
} from "@auctionit/xlsx-import/headers";
import { coerceImportCellString } from "@auctionit/xlsx-import/coerce";
import { readXlsxMatrix } from "@auctionit/xlsx-import/read-xlsx";
import {
  columnRangeFrom,
  ignoreNumberStoredAsText,
} from "@auctionit/xlsx-export";
import type {
  ImportResult,
  ImportRowIssue,
} from "@auctionit/xlsx-import/types";
import { db } from "../db/index.js";
import {
  auctionAdditionalFieldValues,
  clientAdditionalFields,
} from "../db/schema/additional-fields.js";
import { auctionLots } from "../db/schema/auction-lots.js";
import { auctions } from "../db/schema/auctions.js";
import {
  ADDITIONAL_FIELDS_DEFINED_NAME,
  ADDITIONAL_FIELDS_IMPORT_MAX_ISSUES,
  ADDITIONAL_FIELDS_IMPORT_SHEET,
  ADDITIONAL_FIELDS_IMPORT_TEMPLATE_HEADERS,
  ADDITIONAL_FIELDS_MASTERS_SHEET,
  ADDITIONAL_FIELDS_TEMPLATE_SPARE_ROWS,
} from "../lib/additional-fields-import/constants.js";
import { capIssues } from "../lib/import/service-utils.js";
import {
  createImportWorkbook,
  workbookToBuffer,
} from "../lib/import/template-builder.js";
import {
  AuctionNotFoundError,
  AuctionValidationError,
} from "./auctions-errors.js";

export type AuctionAdditionalFieldDef = {
  fieldId: number;
  label: string;
  dataType: AdditionalFieldDataType;
  isActive: boolean;
  displayOrder: number;
};

export type AuctionLevelAdditionalFieldRow = AuctionAdditionalFieldDef & {
  valueId: number;
  value: string | null;
};

export type AuctionAdditionalFieldsOverview = {
  auctionFields: AuctionLevelAdditionalFieldRow[];
  /** Active auction-scope client fields (edit dialog label dropdown). */
  auctionFieldOptions: AuctionAdditionalFieldDef[];
  /** Lot-scope fields selected for this auction (dynamic lot columns). */
  lotFields: AuctionAdditionalFieldDef[];
  clientHasFields: boolean;
};

export type AuctionAdditionalFieldLotRow = {
  lotId: number;
  lotNumber: string;
  displayOrder: string;
  /** fieldId → stored value (ISO for dates); missing key = no row. */
  values: Record<string, string | null>;
};

export type AuctionAdditionalFieldLotsPage = {
  items: AuctionAdditionalFieldLotRow[];
  total: number;
  page: number;
  pageSize: number;
};

type AuctionContext = {
  auctionId: number;
  clientId: number;
  auctionNumber: string | null;
};

type ClientFieldRow = AuctionAdditionalFieldDef & {
  scope: AdditionalFieldScope;
};

const fieldDefColumns = {
  fieldId: clientAdditionalFields.id,
  label: clientAdditionalFields.label,
  dataType: clientAdditionalFields.dataType,
  isActive: clientAdditionalFields.isActive,
  displayOrder: clientAdditionalFields.displayOrder,
};

const fieldOrder = [
  asc(clientAdditionalFields.displayOrder),
  asc(clientAdditionalFields.label),
  asc(clientAdditionalFields.id),
];

async function getAuctionContext(auctionId: number): Promise<AuctionContext> {
  const [row] = await db
    .select({
      auctionId: auctions.id,
      clientId: auctions.clientId,
      auctionNumber: auctions.auctionNumber,
    })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);
  if (!row) throw new AuctionNotFoundError();
  return row;
}

async function listClientFields(
  clientId: number,
  opts: { activeOnly: boolean },
): Promise<ClientFieldRow[]> {
  return db
    .select({ ...fieldDefColumns, scope: clientAdditionalFields.scope })
    .from(clientAdditionalFields)
    .where(
      and(
        eq(clientAdditionalFields.clientId, clientId),
        opts.activeOnly ? eq(clientAdditionalFields.isActive, true) : undefined,
      ),
    )
    .orderBy(asc(clientAdditionalFields.scope), ...fieldOrder);
}

async function listSelectedLotFields(
  auctionId: number,
): Promise<AuctionAdditionalFieldDef[]> {
  const selected = db
    .selectDistinct({ fieldId: auctionAdditionalFieldValues.fieldId })
    .from(auctionAdditionalFieldValues)
    .where(
      and(
        eq(auctionAdditionalFieldValues.auctionId, auctionId),
        isNotNull(auctionAdditionalFieldValues.lotId),
      ),
    );
  return db
    .select(fieldDefColumns)
    .from(clientAdditionalFields)
    .where(inArray(clientAdditionalFields.id, selected))
    .orderBy(...fieldOrder);
}

function invalidValueMessage(
  label: string,
  dataType: AdditionalFieldDataType,
): string {
  if (dataType === "number") {
    return AuctionsValidationMessages.ADDITIONAL_FIELDS_INVALID_NUMBER(label);
  }
  if (dataType === "date") {
    return AuctionsValidationMessages.ADDITIONAL_FIELDS_INVALID_DATE(label);
  }
  if (dataType === "boolean") {
    return AuctionsValidationMessages.ADDITIONAL_FIELDS_INVALID_BOOLEAN(label);
  }
  return AuctionsValidationMessages.ADDITIONAL_FIELDS_TEXT_TOO_LONG(label);
}

/** Validated value for storage or an error message. */
function checkValue(
  field: Pick<AuctionAdditionalFieldDef, "label" | "dataType">,
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const normalized = normalizeAdditionalFieldValue(field.dataType, raw);
  if (!normalized.ok) {
    return {
      ok: false,
      error: invalidValueMessage(field.label, field.dataType),
    };
  }
  return normalized;
}

async function getOverview(
  auctionId: number,
): Promise<AuctionAdditionalFieldsOverview> {
  const ctx = await getAuctionContext(auctionId);

  const [auctionFields, clientFields, lotFields] = await Promise.all([
    db
      .select({
        ...fieldDefColumns,
        valueId: auctionAdditionalFieldValues.id,
        value: auctionAdditionalFieldValues.value,
      })
      .from(auctionAdditionalFieldValues)
      .innerJoin(
        clientAdditionalFields,
        eq(clientAdditionalFields.id, auctionAdditionalFieldValues.fieldId),
      )
      .where(
        and(
          eq(auctionAdditionalFieldValues.auctionId, auctionId),
          isNull(auctionAdditionalFieldValues.lotId),
        ),
      )
      .orderBy(...fieldOrder),
    listClientFields(ctx.clientId, { activeOnly: false }),
    listSelectedLotFields(auctionId),
  ]);

  return {
    auctionFields,
    auctionFieldOptions: clientFields
      .filter((f) => f.scope === "auction" && f.isActive)
      .map(({ scope: _scope, ...def }) => def),
    lotFields,
    clientHasFields: clientFields.some((f) => f.isActive),
  };
}

async function listLots(
  auctionId: number,
  opts: { page: number; pageSize: number; search?: string },
): Promise<AuctionAdditionalFieldLotsPage> {
  await getAuctionContext(auctionId);
  const search = opts.search?.trim();
  const where = and(
    eq(auctionLots.auctionId, auctionId),
    eq(auctionLots.isActive, true),
    search ? ilike(auctionLots.lotNumber, `%${search}%`) : undefined,
  );

  const [totalRow] = await db
    .select({ total: count() })
    .from(auctionLots)
    .where(where);
  const lots = await db
    .select({
      lotId: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
      displayOrder: auctionLots.displayOrder,
    })
    .from(auctionLots)
    .where(where)
    .orderBy(asc(auctionLots.displayOrder), asc(auctionLots.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);

  const valuesByLot = new Map<number, Record<string, string | null>>();
  if (lots.length > 0) {
    const rows = await db
      .select({
        lotId: auctionAdditionalFieldValues.lotId,
        fieldId: auctionAdditionalFieldValues.fieldId,
        value: auctionAdditionalFieldValues.value,
      })
      .from(auctionAdditionalFieldValues)
      .where(
        inArray(
          auctionAdditionalFieldValues.lotId,
          lots.map((l) => l.lotId),
        ),
      );
    for (const r of rows) {
      if (r.lotId == null) continue;
      const bucket = valuesByLot.get(r.lotId) ?? {};
      bucket[String(r.fieldId)] = r.value;
      valuesByLot.set(r.lotId, bucket);
    }
  }

  return {
    items: lots.map((l) => ({
      lotId: l.lotId,
      lotNumber: l.lotNumber ?? "",
      displayOrder: String(l.displayOrder ?? ""),
      values: valuesByLot.get(l.lotId) ?? {},
    })),
    total: Number(totalRow?.total ?? 0),
    page: opts.page,
    pageSize: opts.pageSize,
  };
}

async function updateAuctionRow(
  auctionId: number,
  valueId: number,
  input: { fieldId: number; value: string | null },
  userId: number,
): Promise<void> {
  const ctx = await getAuctionContext(auctionId);
  const [row] = await db
    .select({
      id: auctionAdditionalFieldValues.id,
      fieldId: auctionAdditionalFieldValues.fieldId,
    })
    .from(auctionAdditionalFieldValues)
    .where(
      and(
        eq(auctionAdditionalFieldValues.id, valueId),
        eq(auctionAdditionalFieldValues.auctionId, auctionId),
        isNull(auctionAdditionalFieldValues.lotId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.ADDITIONAL_FIELDS_VALUE_ROW_NOT_FOUND,
    );
  }

  const clientFields = await listClientFields(ctx.clientId, {
    activeOnly: false,
  });
  const current = clientFields.find((f) => f.fieldId === row.fieldId);
  const target = clientFields.find((f) => f.fieldId === input.fieldId);

  if (input.fieldId !== row.fieldId) {
    if (!target || !target.isActive || target.scope !== "auction") {
      throw new AuctionValidationError(
        AuctionsValidationMessages.ADDITIONAL_FIELDS_FIELD_INACTIVE_OR_WRONG_SCOPE,
        {
          fieldId: [
            AuctionsValidationMessages.ADDITIONAL_FIELDS_FIELD_INACTIVE_OR_WRONG_SCOPE,
          ],
        },
      );
    }
    const [used] = await db
      .select({ id: auctionAdditionalFieldValues.id })
      .from(auctionAdditionalFieldValues)
      .where(
        and(
          eq(auctionAdditionalFieldValues.auctionId, auctionId),
          isNull(auctionAdditionalFieldValues.lotId),
          eq(auctionAdditionalFieldValues.fieldId, input.fieldId),
          ne(auctionAdditionalFieldValues.id, valueId),
        ),
      )
      .limit(1);
    if (used) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.ADDITIONAL_FIELDS_FIELD_ALREADY_USED,
        {
          fieldId: [
            AuctionsValidationMessages.ADDITIONAL_FIELDS_FIELD_ALREADY_USED,
          ],
        },
      );
    }
  }

  const field = target ?? current;
  if (!field) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.ADDITIONAL_FIELDS_VALUE_ROW_NOT_FOUND,
    );
  }
  const checked = checkValue(field, input.value);
  if (!checked.ok) {
    throw new AuctionValidationError(checked.error, { value: [checked.error] });
  }

  await db
    .update(auctionAdditionalFieldValues)
    .set({
      fieldId: input.fieldId,
      value: checked.value,
      updatedAt: formatUtcNow(),
      updatedBy: userId,
    })
    .where(eq(auctionAdditionalFieldValues.id, valueId));
}

async function updateLotValues(
  auctionId: number,
  lotId: number,
  values: { fieldId: number; value: string | null }[],
  userId: number,
): Promise<void> {
  await getAuctionContext(auctionId);
  const [lot] = await db
    .select({ id: auctionLots.id })
    .from(auctionLots)
    .where(
      and(
        eq(auctionLots.id, lotId),
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.isActive, true),
      ),
    )
    .limit(1);
  if (!lot) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.ADDITIONAL_FIELDS_LOT_NOT_IN_AUCTION,
    );
  }

  const selected = new Map(
    (await listSelectedLotFields(auctionId)).map((f) => [f.fieldId, f]),
  );
  const fieldErrors: Record<string, string[]> = {};
  const checked: { fieldId: number; value: string | null }[] = [];
  for (const v of values) {
    const key = `values.${v.fieldId}`;
    const field = selected.get(v.fieldId);
    if (!field) {
      fieldErrors[key] = [
        AuctionsValidationMessages.ADDITIONAL_FIELDS_FIELD_NOT_SELECTED,
      ];
      continue;
    }
    const result = checkValue(field, v.value);
    if (!result.ok) {
      fieldErrors[key] = [result.error];
      continue;
    }
    checked.push({ fieldId: v.fieldId, value: result.value });
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new AuctionValidationError(
      Object.values(fieldErrors)[0]![0]!,
      fieldErrors,
    );
  }
  if (checked.length === 0) return;

  const now = formatUtcNow();
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: auctionAdditionalFieldValues.id,
        fieldId: auctionAdditionalFieldValues.fieldId,
      })
      .from(auctionAdditionalFieldValues)
      .where(eq(auctionAdditionalFieldValues.lotId, lotId));
    const idByField = new Map(existing.map((e) => [e.fieldId, e.id]));

    for (const v of checked) {
      const id = idByField.get(v.fieldId);
      if (id != null) {
        await tx
          .update(auctionAdditionalFieldValues)
          .set({ value: v.value, updatedAt: now, updatedBy: userId })
          .where(eq(auctionAdditionalFieldValues.id, id));
      } else {
        await tx.insert(auctionAdditionalFieldValues).values({
          auctionId,
          lotId,
          fieldId: v.fieldId,
          value: v.value,
          createdBy: userId,
        });
      }
    }
  });
}

export type ReportAdditionalFieldColumn = {
  key: string;
  fieldId: number;
  label: string;
  scope: AdditionalFieldScope;
  dataType: AdditionalFieldDataType;
};

export type ReportAdditionalFieldData = {
  /** Auction-scope columns first, then lot-scope (each by display order). */
  columns: ReportAdditionalFieldColumn[];
  /** Display values (dates as DD-MM-YYYY) keyed by column key. */
  auctionValues: Record<string, string>;
  lotValues: Map<number, Record<string, string>>;
};

/** Dynamic report columns for the fields selected on an auction (includes inactive fields). */
async function loadAdditionalFieldColumns(
  auctionId: number,
): Promise<ReportAdditionalFieldData> {
  const rows = await db
    .select({
      lotId: auctionAdditionalFieldValues.lotId,
      fieldId: clientAdditionalFields.id,
      label: clientAdditionalFields.label,
      scope: clientAdditionalFields.scope,
      dataType: clientAdditionalFields.dataType,
      displayOrder: clientAdditionalFields.displayOrder,
      value: auctionAdditionalFieldValues.value,
    })
    .from(auctionAdditionalFieldValues)
    .innerJoin(
      clientAdditionalFields,
      eq(clientAdditionalFields.id, auctionAdditionalFieldValues.fieldId),
    )
    .where(eq(auctionAdditionalFieldValues.auctionId, auctionId));

  const byField = new Map<
    number,
    ReportAdditionalFieldColumn & { displayOrder: number }
  >();
  const auctionValues: Record<string, string> = {};
  const lotValues = new Map<number, Record<string, string>>();
  for (const r of rows) {
    const key = `af_${r.fieldId}`;
    if (!byField.has(r.fieldId)) {
      byField.set(r.fieldId, {
        key,
        fieldId: r.fieldId,
        label: r.label,
        scope: r.scope,
        dataType: r.dataType,
        displayOrder: r.displayOrder,
      });
    }
    const display = formatAdditionalFieldValue(r.dataType, r.value);
    if (r.lotId == null) {
      auctionValues[key] = display;
    } else {
      const bucket = lotValues.get(r.lotId) ?? {};
      bucket[key] = display;
      lotValues.set(r.lotId, bucket);
    }
  }

  const scopeRank: Record<AdditionalFieldScope, number> = {
    auction: 0,
    lot: 1,
  };
  const columns = [...byField.values()]
    .sort(
      (a, b) =>
        scopeRank[a.scope] - scopeRank[b.scope] ||
        a.displayOrder - b.displayOrder ||
        a.label.localeCompare(b.label) ||
        a.fieldId - b.fieldId,
    )
    .map(({ displayOrder: _displayOrder, ...col }) => col);

  return { columns, auctionValues, lotValues };
}

async function countSelectedFields(auctionId: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`count(distinct ${auctionAdditionalFieldValues.fieldId})::int`,
    })
    .from(auctionAdditionalFieldValues)
    .where(eq(auctionAdditionalFieldValues.auctionId, auctionId));
  return Number(row?.total ?? 0);
}

async function clientHasActiveFields(clientId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: clientAdditionalFields.id })
    .from(clientAdditionalFields)
    .where(
      and(
        eq(clientAdditionalFields.clientId, clientId),
        eq(clientAdditionalFields.isActive, true),
      ),
    )
    .limit(1);
  return row != null;
}

// ---------------------------------------------------------------------------
// Excel template + import
// ---------------------------------------------------------------------------

type ActiveLot = { lotId: number; lotNumber: string };

async function listActiveLots(auctionId: number): Promise<ActiveLot[]> {
  const rows = await db
    .select({ lotId: auctionLots.id, lotNumber: auctionLots.lotNumber })
    .from(auctionLots)
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.isActive, true)),
    )
    .orderBy(asc(auctionLots.displayOrder), asc(auctionLots.id));
  return rows.map((r) => ({
    lotId: r.lotId,
    lotNumber: (r.lotNumber ?? "").trim(),
  }));
}

export function buildAdditionalFieldsTemplateFilename(
  auctionNumber: string | null,
  auctionId: number,
): string {
  const base = (auctionNumber ?? `auction-${auctionId}`).replace(
    /[^A-Za-z0-9._-]+/g,
    "_",
  );
  return `${base}-additional-fields.xlsx`;
}

async function buildTemplate(
  auctionId: number,
): Promise<{ buffer: Buffer; filename: string }> {
  const ctx = await getAuctionContext(auctionId);
  const activeFields = await listClientFields(ctx.clientId, {
    activeOnly: true,
  });

  const { workbook, sheet } = createImportWorkbook({
    sheetName: ADDITIONAL_FIELDS_IMPORT_SHEET,
    headers: ADDITIONAL_FIELDS_IMPORT_TEMPLATE_HEADERS,
  });
  // Text columns so Excel keeps lot numbers and DD-MM-YYYY dates as typed.
  for (let c = 1; c <= 4; c++) sheet.getColumn(c).numFmt = "@";

  const firstRow = sheet.getRow(2);
  firstRow.getCell(1).value = ctx.auctionNumber ?? "";
  firstRow.commit();

  const masters = workbook.addWorksheet(ADDITIONAL_FIELDS_MASTERS_SHEET);
  masters.state = "hidden";
  ["Label", "Scope", "Type", "Format"].forEach((h, i) => {
    const cell = masters.getRow(1).getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
  });
  masters.getColumn(1).width = 36;
  masters.getColumn(2).width = 10;
  masters.getColumn(3).width = 12;
  masters.getColumn(4).width = 18;
  activeFields.forEach((f, i) => {
    const row = masters.getRow(i + 2);
    row.getCell(1).value = f.label;
    row.getCell(2).value = ADDITIONAL_FIELD_SCOPE_LABELS[f.scope];
    row.getCell(3).value = ADDITIONAL_FIELD_DATA_TYPE_LABELS[f.dataType];
    row.getCell(4).value = ADDITIONAL_FIELD_FORMAT_LABELS[f.dataType];
    row.commit();
  });

  if (activeFields.length > 0) {
    workbook.definedNames.add(
      `'${ADDITIONAL_FIELDS_MASTERS_SHEET}'!$A$2:$A$${activeFields.length + 1}`,
      ADDITIONAL_FIELDS_DEFINED_NAME,
    );
    const lastRow = ADDITIONAL_FIELDS_TEMPLATE_SPARE_ROWS + 2;
    for (let r = 2; r <= lastRow; r++) {
      sheet.getRow(r).getCell(3).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`=${ADDITIONAL_FIELDS_DEFINED_NAME}`],
        showErrorMessage: true,
        errorTitle:
          AuctionsValidationMessages.ADDITIONAL_FIELDS_TEMPLATE_INVALID_FIELD_TITLE,
        error: AuctionsValidationMessages.ADDITIONAL_FIELDS_TEMPLATE_CHOOSE_FIELD,
      };
    }
  }

  const buffer = await ignoreNumberStoredAsText(
    await workbookToBuffer(workbook),
    {
      [ADDITIONAL_FIELDS_IMPORT_SHEET]: [1, 2, 3, 4].map((c) =>
        columnRangeFrom(c, 2),
      ),
    },
  );

  return {
    buffer,
    filename: buildAdditionalFieldsTemplateFilename(
      ctx.auctionNumber,
      auctionId,
    ),
  };
}

type ParsedImportRow = {
  rowNumber: number;
  auctionNo: string;
  lotNo: string;
  fieldName: string;
  fieldValue: string;
};

function parseImportMatrix(matrix: unknown[][]): ParsedImportRow[] {
  if (matrix.length === 0) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.ADDITIONAL_FIELDS_SPREADSHEET_EMPTY,
    );
  }
  const { columnIndexByKey, missingLabels } = buildHeaderIndexMap(
    matrix[0] ?? [],
    ADDITIONAL_FIELDS_IMPORT_TEMPLATE_HEADERS,
  );
  if (missingLabels.length > 0) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.ADDITIONAL_FIELDS_HEADER_MISSING(
        missingLabels.join(", "),
      ),
    );
  }

  const rows: ParsedImportRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const cols = matrix[i] ?? [];
    if (isImportRowBlank(cols)) continue;
    const cell = (key: string) =>
      coerceImportCellString(cellByHeaderKey(cols, columnIndexByKey, key));
    const row: ParsedImportRow = {
      rowNumber: i + 1,
      auctionNo: cell("auctionNo"),
      lotNo: cell("lotNo"),
      fieldName: cell("fieldName"),
      fieldValue: cell("fieldValue"),
    };
    // The template's prefilled Auction No. row is blank until a field is entered.
    if (!row.lotNo && !row.fieldName && !row.fieldValue) continue;
    rows.push(row);
  }
  if (rows.length === 0) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.ADDITIONAL_FIELDS_NO_ROWS,
    );
  }
  return rows;
}

export type AdditionalFieldsImportResult = ImportResult & {
  created: number;
  updated: number;
  deleted: number;
};

/**
 * Sync import keyed by (Lot No., field): matching rows update, new rows are
 * added, and saved values of active fields missing from the file are deleted.
 * Every row must validate first; values of inactive fields are left untouched.
 */
async function importXlsx(
  auctionId: number,
  buffer: Buffer,
  userId: number,
): Promise<AdditionalFieldsImportResult> {
  const ctx = await getAuctionContext(auctionId);
  const { matrix } = await readXlsxMatrix(buffer, {
    preferredSheetNames: [ADDITIONAL_FIELDS_IMPORT_SHEET],
  });
  const rows = parseImportMatrix(matrix);

  const [activeFields, lots] = await Promise.all([
    listClientFields(ctx.clientId, { activeOnly: true }),
    listActiveLots(auctionId),
  ]);
  const fieldByScopeLabel = new Map(
    activeFields.map((f) => [`${f.scope}:${f.label.toLowerCase()}`, f]),
  );
  const fieldsByLabel = new Map<string, ClientFieldRow[]>();
  for (const f of activeFields) {
    const k = f.label.toLowerCase();
    fieldsByLabel.set(k, [...(fieldsByLabel.get(k) ?? []), f]);
  }
  const lotByNumber = new Map<string, ActiveLot>();
  for (const lot of lots) {
    const k = lot.lotNumber.toLowerCase();
    if (!lotByNumber.has(k)) lotByNumber.set(k, lot);
  }

  const expectedAuctionNo = (ctx.auctionNumber ?? "").trim();
  const issues: ImportRowIssue[] = [];
  const failedRows = new Set<number>();
  const fail = (rowNumber: number, reason: string) => {
    issues.push({ rowNumber, kind: "error", reason });
    failedRows.add(rowNumber);
  };

  const accepted: {
    rowNumber: number;
    lotId: number | null;
    field: ClientFieldRow;
    value: string | null;
  }[] = [];
  const firstRowByKey = new Map<string, number>();

  for (const row of rows) {
    const reasons: string[] = [];

    if (!row.auctionNo) {
      reasons.push(
        AuctionsValidationMessages.ADDITIONAL_FIELDS_AUCTION_NO_REQUIRED,
      );
    } else if (
      row.auctionNo.toLowerCase() !== expectedAuctionNo.toLowerCase()
    ) {
      reasons.push(
        AuctionsValidationMessages.ADDITIONAL_FIELDS_AUCTION_NO_MISMATCH(
          expectedAuctionNo,
        ),
      );
    }

    let lot: ActiveLot | null = null;
    if (row.lotNo) {
      lot = lotByNumber.get(row.lotNo.toLowerCase()) ?? null;
      if (!lot) {
        reasons.push(
          AuctionsValidationMessages.ADDITIONAL_FIELDS_LOT_NOT_FOUND(row.lotNo),
        );
      }
    }
    const scope: AdditionalFieldScope = row.lotNo ? "lot" : "auction";

    let field: ClientFieldRow | null = null;
    if (!row.fieldName) {
      reasons.push(AuctionsValidationMessages.ADDITIONAL_FIELDS_NAME_REQUIRED);
    } else {
      field =
        fieldByScopeLabel.get(`${scope}:${row.fieldName.toLowerCase()}`) ??
        null;
      if (!field) {
        const other = fieldsByLabel.get(row.fieldName.toLowerCase());
        if (!other) {
          reasons.push(
            AuctionsValidationMessages.ADDITIONAL_FIELDS_NAME_UNKNOWN(
              row.fieldName,
            ),
          );
        } else if (scope === "auction") {
          reasons.push(
            AuctionsValidationMessages.ADDITIONAL_FIELDS_NAME_IS_LOT_LEVEL(
              row.fieldName,
            ),
          );
        } else {
          reasons.push(
            AuctionsValidationMessages.ADDITIONAL_FIELDS_NAME_IS_AUCTION_LEVEL(
              row.fieldName,
            ),
          );
        }
      }
    }

    let value: string | null = null;
    if (field) {
      const checked = checkValue(field, row.fieldValue);
      if (checked.ok) value = checked.value;
      else reasons.push(checked.error);
    }

    if (field && (scope === "auction" || lot)) {
      const key = `${lot?.lotId ?? "A"}:${field.fieldId}`;
      const first = firstRowByKey.get(key);
      if (first != null) {
        reasons.push(
          AuctionsValidationMessages.ADDITIONAL_FIELDS_DUPLICATE_ROW(first),
        );
      } else {
        firstRowByKey.set(key, row.rowNumber);
      }
    }

    if (reasons.length > 0) {
      fail(row.rowNumber, reasons.join(" "));
      continue;
    }
    accepted.push({
      rowNumber: row.rowNumber,
      lotId: lot?.lotId ?? null,
      field: field!,
      value,
    });
  }

  if (issues.length > 0) {
    const capped = capIssues(issues, ADDITIONAL_FIELDS_IMPORT_MAX_ISSUES);
    return {
      imported: 0,
      failed: failedRows.size,
      skipped: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      issues: capped.issues,
      issuesTruncated: capped.issuesTruncated,
    };
  }

  const activeIds = activeFields.map((f) => f.fieldId);
  const existing =
    activeIds.length > 0
      ? await db
          .select({
            id: auctionAdditionalFieldValues.id,
            lotId: auctionAdditionalFieldValues.lotId,
            fieldId: auctionAdditionalFieldValues.fieldId,
            value: auctionAdditionalFieldValues.value,
          })
          .from(auctionAdditionalFieldValues)
          .where(
            and(
              eq(auctionAdditionalFieldValues.auctionId, auctionId),
              inArray(auctionAdditionalFieldValues.fieldId, activeIds),
            ),
          )
      : [];
  const valueKey = (lotId: number | null, fieldId: number) =>
    `${lotId ?? "A"}:${fieldId}`;
  const existingByKey = new Map(
    existing.map((e) => [valueKey(e.lotId, e.fieldId), e]),
  );

  const toInsert: typeof accepted = [];
  const toUpdate: { id: number; value: string | null }[] = [];
  const rowIssues: ImportRowIssue[] = [];
  const fileKeys = new Set<string>();
  for (const a of accepted) {
    const key = valueKey(a.lotId, a.field.fieldId);
    fileKeys.add(key);
    const current = existingByKey.get(key);
    let reason: string;
    if (!current) {
      toInsert.push(a);
      reason = AuctionsValidationMessages.ADDITIONAL_FIELDS_ROW_CREATED;
    } else if ((current.value ?? null) !== a.value) {
      toUpdate.push({ id: current.id, value: a.value });
      reason = AuctionsValidationMessages.ADDITIONAL_FIELDS_ROW_UPDATED;
    } else {
      reason = AuctionsValidationMessages.ADDITIONAL_FIELDS_ROW_UNCHANGED;
    }
    rowIssues.push({ rowNumber: a.rowNumber, kind: "uploaded", reason });
  }
  const deleteIds = existing
    .filter((e) => !fileKeys.has(valueKey(e.lotId, e.fieldId)))
    .map((e) => e.id);

  const batchSize = 1000;
  const now = formatUtcNow();
  await db.transaction(async (tx) => {
    for (let i = 0; i < deleteIds.length; i += batchSize) {
      await tx
        .delete(auctionAdditionalFieldValues)
        .where(
          inArray(
            auctionAdditionalFieldValues.id,
            deleteIds.slice(i, i + batchSize),
          ),
        );
    }
    for (let i = 0; i < toUpdate.length; i += batchSize) {
      const values = sql.join(
        toUpdate
          .slice(i, i + batchSize)
          .map((u) => sql`(${u.id}::int, ${u.value}::varchar)`),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE auction_additional_field_values AS t
        SET value = v.value, updated_at = ${now}, updated_by = ${userId}
        FROM (VALUES ${values}) AS v(id, value)
        WHERE t.id = v.id
      `);
    }
    for (let i = 0; i < toInsert.length; i += batchSize) {
      await tx.insert(auctionAdditionalFieldValues).values(
        toInsert.slice(i, i + batchSize).map((a) => ({
          auctionId,
          lotId: a.lotId,
          fieldId: a.field.fieldId,
          value: a.value,
          createdBy: userId,
        })),
      );
    }
  });

  const capped = capIssues(rowIssues, ADDITIONAL_FIELDS_IMPORT_MAX_ISSUES);
  return {
    imported: accepted.length,
    failed: 0,
    skipped: 0,
    created: toInsert.length,
    updated: toUpdate.length,
    deleted: deleteIds.length,
    issues: capped.issues,
    issuesTruncated: capped.issuesTruncated,
  };
}

export const auctionAdditionalFieldsService = {
  getOverview,
  listLots,
  updateAuctionRow,
  updateLotValues,
  countSelectedFields,
  clientHasActiveFields,
  loadAdditionalFieldColumns,
  buildTemplate,
  importXlsx,
};

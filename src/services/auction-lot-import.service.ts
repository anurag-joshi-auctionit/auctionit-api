import { normalizeFuzzyText } from "@auctionit/lib/fuzzy-match";
import { collectLotWriteScheduleErrors } from "@auctionit/lib/lot-schedule";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { auctions } from "../db/schema/index.js";
import {
  AUCTION_LOT_IMPORT_BATCH_SIZE,
  AUCTION_LOT_IMPORT_MAX_ISSUES_IN_RESPONSE,
  AUCTION_LOT_IMPORT_MAX_ROWS,
} from "../lib/auction-lot-import-constants.js";
import {
  dedupeRowsByDisplayOrder,
  normalizeDisplayOrderKey,
} from "../lib/auction-lot-display-order.js";
import {
  formatFieldErrors,
  type ParsedAuctionLotImportRow,
} from "../lib/auction-lot-import-parse.js";
import type {
  AuctionLotImportNeedsReview,
  AuctionLotImportProgress,
  AuctionLotImportResult,
  AuctionLotImportStagingRow,
  ImportRowIssue,
} from "../lib/auction-lot-import-types.js";
import {
  capIssues,
  chunkArray,
  clampPercent,
  schemaErrorsToIssues,
} from "../lib/import/service-utils.js";
import { parseAuctionLotImportXlsxBuffer } from "../lib/parse-auction-lot-import-buffer.js";
import {
  createLotImportStagingSession,
  deleteLotImportStagingSession,
  loadStagingPayloadForConfirm,
} from "./auction-lot-import-staging.service.js";
import {
  matchMaterialNames,
  pgLoadClientItemMatchCorpus,
} from "./auction-lot-item-match.service.js";
import {
  pgBulkInsertLots,
  pgBulkUpdateLots,
  pgLoadBenchmarkComboLabelMap,
  pgLoadClientItemIdSet,
  pgLoadExistingLotsByDisplayOrder,
  pgLoadMaterialLocationNameMap,
  pgLoadPlantLocationNameMap,
  pgLoadUomCodeMap,
  pgWithdrawLots,
  type ExistingLotByDisplayOrder,
  type PgLotInsertRow,
  type PgLotUpdateRow,
} from "./auctions-pg.service.js";
import { AuctionValidationError } from "./auctions.service.js";

function normalizeLotKey(lotNumber: string): string {
  return lotNumber.trim().toLowerCase();
}

function parseSchemaIssues(
  rowErrors: { rowNumber: number; fieldErrors: Record<string, string[]> }[],
): ImportRowIssue[] {
  return schemaErrorsToIssues(rowErrors, formatFieldErrors);
}

function capImportIssues(issues: ImportRowIssue[]) {
  return capIssues(issues, AUCTION_LOT_IMPORT_MAX_ISSUES_IN_RESPONSE);
}

function dedupeRowsByLotNumber(rows: ParsedAuctionLotImportRow[]): {
  unique: ParsedAuctionLotImportRow[];
  skippedIssues: ImportRowIssue[];
} {
  const byLotNumber = new Map<string, ParsedAuctionLotImportRow>();
  const skippedIssues: ImportRowIssue[] = [];

  for (const row of rows) {
    const key = normalizeLotKey(row.data.lotNumber);
    const existing = byLotNumber.get(key);
    if (existing) {
      if (row.rowNumber > existing.rowNumber) {
        skippedIssues.push({
          rowNumber: existing.rowNumber,
          kind: "skipped",
          reason: AuctionsValidationMessages.DUPLICATE_LOT_NUMBER_IN_FILE(
            row.rowNumber,
          ),
        });
        byLotNumber.set(key, row);
      } else {
        skippedIssues.push({
          rowNumber: row.rowNumber,
          kind: "skipped",
          reason: AuctionsValidationMessages.DUPLICATE_LOT_NUMBER_IN_FILE(
            existing.rowNumber,
          ),
        });
      }
      continue;
    }
    byLotNumber.set(key, row);
  }

  return {
    unique: [...byLotNumber.values()].sort((a, b) => a.rowNumber - b.rowNumber),
    skippedIssues,
  };
}

type ResolvedImportRow = {
  rowNumber: number;
  lotNumber: string;
  materialLiftingDays: number | null;
  plantLocationId: number;
  materialLocationId: number | null;
  gstPercentage: 0 | 5 | 12 | 18 | 28;
  tcsPercentage: number;
  startBidPrice: number;
  bidLimit: number;
  bidIncrement: number;
  lotStartTime: string;
  lotEndTime: string;
  loadingScope: ParsedAuctionLotImportRow["data"]["loadingScope"];
  displayOrder: number;
  remark: string;
  quantity: number;
  uomCode: string;
  uomId: number;
  benchmarkMaterialLocationId: number | null;
  materialName: string;
  materialDescription: string | null;
  itemId: number;
  existing: ExistingLotByDisplayOrder | null;
};

function toLotWriteRow(
  resolved: ResolvedImportRow,
): Omit<PgLotInsertRow, "rowNumber"> & { rowNumber: number } {
  return {
    rowNumber: resolved.rowNumber,
    lotNumber: resolved.lotNumber,
    materialLiftingDays: resolved.materialLiftingDays,
    plantLocationId: resolved.plantLocationId,
    materialLocationId: resolved.materialLocationId,
    gstPercentage: resolved.gstPercentage,
    tcsPercentage: resolved.tcsPercentage,
    startBidPrice: resolved.startBidPrice,
    bidLimit: resolved.bidLimit,
    bidIncrement: resolved.bidIncrement,
    lotStartTime: resolved.lotStartTime,
    lotEndTime: resolved.lotEndTime,
    loadingScope: resolved.loadingScope,
    displayOrder: resolved.displayOrder,
    remark: resolved.remark,
    itemId: resolved.itemId,
    quantity: resolved.quantity,
    uomCode: resolved.uomCode,
    uomId: resolved.uomId,
    benchmarkMaterialLocationId: resolved.benchmarkMaterialLocationId,
    materialName: resolved.materialName,
    materialDescription: resolved.materialDescription,
  };
}

async function upsertResolvedLots(params: {
  auctionId: number;
  clientId: number;
  userId: number;
  resolvedRows: ResolvedImportRow[];
  existingByDisplayOrder: Map<string, ExistingLotByDisplayOrder>;
  issues: ImportRowIssue[];
  onProgress?: (update: AuctionLotImportProgress) => void;
}): Promise<{ imported: number; withdrawn: number }> {
  const {
    auctionId,
    clientId,
    userId,
    resolvedRows,
    existingByDisplayOrder,
    issues,
    onProgress,
  } = params;

  const toUpdate: PgLotUpdateRow[] = [];
  const toInsert: PgLotInsertRow[] = [];
  const fileDisplayOrders = new Set<string>();

  for (const candidate of resolvedRows) {
    const displayOrderKey = normalizeDisplayOrderKey(candidate.displayOrder);
    const existing = existingByDisplayOrder.get(displayOrderKey) ?? null;

    if (existing && !existing.isActive) {
      issues.push({
        rowNumber: candidate.rowNumber,
        kind: "skipped",
        reason: AuctionsValidationMessages.IMPORT_ROW_SKIPPED_WITHDRAWN,
      });
      continue;
    }

    fileDisplayOrders.add(displayOrderKey);

    if (existing) {
      toUpdate.push({
        ...toLotWriteRow(candidate),
        lotId: existing.id,
      });
      continue;
    }

    toInsert.push(toLotWriteRow(candidate));
  }

  // Soft-withdraw keeps the lot (and its lot number) in the auction, so
  // withdrawn numbers stay taken. Lots being updated free their old numbers
  // so renames within the file can claim them.
  const withdrawingLotIds = new Set<number>();
  for (const lot of existingByDisplayOrder.values()) {
    if (!lot.isActive) continue;
    if (fileDisplayOrders.has(lot.displayOrderKey)) continue;
    withdrawingLotIds.add(lot.id);
  }
  const updatingLotIds = new Set(toUpdate.map((r) => r.lotId));
  const takenLotNumbers = new Set<string>();
  for (const lot of existingByDisplayOrder.values()) {
    if (!lot.lotNumber) continue;
    if (updatingLotIds.has(lot.id)) continue;
    takenLotNumbers.add(normalizeLotKey(lot.lotNumber));
  }

  const seenLotNumbers = new Set<string>();
  const acceptedUpdates: PgLotUpdateRow[] = [];
  const acceptedInserts: PgLotInsertRow[] = [];

  for (const row of toUpdate) {
    const key = normalizeLotKey(row.lotNumber);
    if (seenLotNumbers.has(key) || takenLotNumbers.has(key)) {
      issues.push({
        rowNumber: row.rowNumber,
        kind: "error",
        reason: AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS,
        fieldErrors: {
          lotNumber: [AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS],
        },
      });
      continue;
    }
    seenLotNumbers.add(key);
    acceptedUpdates.push(row);
  }

  for (const row of toInsert) {
    const key = normalizeLotKey(row.lotNumber);
    if (seenLotNumbers.has(key) || takenLotNumbers.has(key)) {
      issues.push({
        rowNumber: row.rowNumber,
        kind: "error",
        reason: AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS,
        fieldErrors: {
          lotNumber: [AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS],
        },
      });
      continue;
    }
    seenLotNumbers.add(key);
    acceptedInserts.push(row);
  }

  const total = acceptedInserts.length + acceptedUpdates.length;
  let imported = 0;

  if (total > 0) {
    const insertBatches = chunkArray(
      acceptedInserts,
      AUCTION_LOT_IMPORT_BATCH_SIZE,
    );
    const updateBatches = chunkArray(
      acceptedUpdates,
      AUCTION_LOT_IMPORT_BATCH_SIZE,
    );

    for (const batch of insertBatches) {
      await pgBulkInsertLots(auctionId, clientId, batch, userId);
      imported += batch.length;
      for (const row of batch) {
        issues.push({
          rowNumber: row.rowNumber,
          kind: "uploaded",
          reason: AuctionsValidationMessages.IMPORT_ROW_UPLOADED,
        });
      }
      onProgress?.({
        phase: "import",
        processed: imported,
        total,
        percent: clampPercent(20 + (imported / total) * 70),
        label: `Imported/updated ${imported} of ${total} lots`,
      });
    }

    for (const batch of updateBatches) {
      await pgBulkUpdateLots(auctionId, clientId, batch, userId);
      imported += batch.length;
      for (const row of batch) {
        issues.push({
          rowNumber: row.rowNumber,
          kind: "uploaded",
          reason: AuctionsValidationMessages.IMPORT_ROW_UPDATED,
        });
      }
      onProgress?.({
        phase: "import",
        processed: imported,
        total,
        percent: clampPercent(20 + (imported / total) * 70),
        label: `Imported/updated ${imported} of ${total} lots`,
      });
    }
  }

  // Soft-withdraw active lots whose display order is absent from the file.
  // Skipped (already-withdrawn) rows do not count as present in the file.
  const missingLotIds = [...withdrawingLotIds];

  const withdrawn =
    missingLotIds.length > 0
      ? await pgWithdrawLots(auctionId, missingLotIds, userId)
      : 0;

  onProgress?.({
    phase: "import",
    processed: imported,
    total: Math.max(total, 1),
    percent: 100,
    label:
      withdrawn > 0
        ? `Imported/updated ${imported}; withdrew ${withdrawn}`
        : total > 0
          ? `Imported/updated ${imported} of ${total} lots`
          : "No lots to import",
  });

  return { imported, withdrawn };
}

export type AuctionLotImportRunOutcome =
  | { kind: "imported"; result: AuctionLotImportResult }
  | { kind: "needsReview"; review: AuctionLotImportNeedsReview };

export class AuctionLotImportService {
  async runImportFromBuffer(
    auctionId: number,
    clientId: number,
    buffer: Buffer,
    userId: number,
    auctionDate: string,
    onProgress?: (update: AuctionLotImportProgress) => void,
  ): Promise<AuctionLotImportRunOutcome> {
    onProgress?.({
      phase: "parse",
      processed: 0,
      total: 0,
      percent: 5,
      label: "Parsing spreadsheet",
    });

    const [auctionRow] = await db
      .select({
        auctionType: auctions.auctionType,
        publishedAt: auctions.publishedAt,
        raStageMaxEndsAt: sql<string | null>`(
          SELECT MAX(ends_at) FROM auction_ra_stages
          WHERE auction_id = ${auctionId} AND enabled = true
        )`,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const parsed = await parseAuctionLotImportXlsxBuffer(buffer, {
      auctionType: auctionRow?.auctionType ?? null,
    });
    const parseIssues = parseSchemaIssues(parsed.rowErrors);

    // Headers-only / no data rows (and no header/schema row errors) → hard fail
    // so we never soft-complete or unpublish with zero lot changes.
    if (parsed.rows.length === 0 && parsed.rowErrors.length === 0) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_IMPORT_SPREADSHEET_EMPTY,
      );
    }

    if (parsed.rows.length > AUCTION_LOT_IMPORT_MAX_ROWS) {
      throw new AuctionValidationError(
        `Import exceeds maximum of ${AUCTION_LOT_IMPORT_MAX_ROWS.toLocaleString()} rows`,
      );
    }

    const { unique: uniqueByLot, skippedIssues: lotSkipped } =
      dedupeRowsByLotNumber(parsed.rows);
    const { unique, skippedIssues: displayOrderSkipped } =
      dedupeRowsByDisplayOrder(uniqueByLot);
    const issues: ImportRowIssue[] = [
      ...parseIssues,
      ...lotSkipped,
      ...displayOrderSkipped,
    ];

    onProgress?.({
      phase: "parse",
      processed: unique.length,
      total: unique.length,
      percent: 20,
      label: "Validated rows",
    });

    const [
      uomMap,
      plantMap,
      materialMap,
      benchmarkMap,
      itemIds,
      existingByDisplayOrder,
    ] = await Promise.all([
      pgLoadUomCodeMap(),
      pgLoadPlantLocationNameMap(clientId),
      pgLoadMaterialLocationNameMap(clientId),
      pgLoadBenchmarkComboLabelMap(),
      pgLoadClientItemIdSet(clientId),
      pgLoadExistingLotsByDisplayOrder(auctionId),
    ]);

    type PartialResolved = {
      row: ParsedAuctionLotImportRow;
      plantLocationId: number;
      materialLocationId: number | null;
      benchmarkMaterialLocationId: number | null;
      uomId: number;
      itemId: number | null;
      existing: ExistingLotByDisplayOrder | null;
    };

    const partialRows: PartialResolved[] = [];

    for (const row of unique) {
      const fieldErrors: Record<string, string[]> = {};

      const uomId = uomMap.get(row.data.uom.trim().toUpperCase());
      if (!uomId) {
        fieldErrors.uom = [`Unknown UOM: ${row.data.uom}`];
      }

      const plantLocationId = plantMap.get(
        row.data.plantLocation.trim().toLowerCase(),
      );
      if (!plantLocationId) {
        fieldErrors.plantLocation = [
          `Unknown plant location: ${row.data.plantLocation}`,
        ];
      }

      const materialRaw = row.data.materialLocation?.trim() ?? "";
      let materialLocationId: number | null = null;
      if (materialRaw) {
        materialLocationId =
          materialMap.get(materialRaw.toLowerCase()) ?? null;
        if (!materialLocationId) {
          fieldErrors.materialLocation = [
            `Unknown material location: ${row.data.materialLocation}`,
          ];
        }
      }

      const benchRaw = row.data.benchmarkMaterial?.trim() ?? "";
      let benchmarkMaterialLocationId: number | null = null;
      if (benchRaw) {
        const benchKey = benchRaw.toLowerCase();
        benchmarkMaterialLocationId = benchmarkMap.get(benchKey) ?? null;
        if (!benchmarkMaterialLocationId) {
          fieldErrors.benchmarkMaterial = [
            `Unknown benchmark: ${row.data.benchmarkMaterial}`,
          ];
        }
      }

      const rawItemId = row.data.itemId ?? null;
      let itemId: number | null = null;
      if (rawItemId != null) {
        if (!itemIds.has(rawItemId)) {
          fieldErrors.itemId = [`Unknown item id: ${rawItemId}`];
        } else {
          itemId = rawItemId;
        }
      }

      const scheduleErrors = collectLotWriteScheduleErrors(
        row.data.lotStartTime,
        row.data.lotEndTime,
        auctionDate,
        undefined,
        auctionRow?.publishedAt,
        auctionRow?.raStageMaxEndsAt,
      );
      if (scheduleErrors) {
        Object.assign(fieldErrors, scheduleErrors);
      }

      if (Object.keys(fieldErrors).length > 0) {
        issues.push({
          rowNumber: row.rowNumber,
          kind: "error",
          reason: formatFieldErrors(fieldErrors),
          fieldErrors,
        });
        continue;
      }

      const displayOrderKey = normalizeDisplayOrderKey(row.data.displayOrder);
      partialRows.push({
        row,
        plantLocationId: plantLocationId!,
        materialLocationId,
        benchmarkMaterialLocationId,
        uomId: uomId!,
        itemId,
        existing: existingByDisplayOrder.get(displayOrderKey) ?? null,
      });
    }

    // Stage valid rows that need item matching even when other rows failed/skipped.
    const failedCount = issues.filter((i) => i.kind === "error").length;
    const skippedCount = issues.filter((i) => i.kind === "skipped").length;
    const needsMatch = partialRows.some((r) => r.itemId == null);

    if (needsMatch && partialRows.length > 0) {
      onProgress?.({
        phase: "parse",
        processed: partialRows.length,
        total: partialRows.length,
        percent: 40,
        label: "Matching material names",
      });

      const corpus = await pgLoadClientItemMatchCorpus(clientId);
      const namesToMatch = partialRows
        .filter((r) => r.itemId == null)
        .map((r) => r.row.data.materialName);
      const matchByNormalized = matchMaterialNames(namesToMatch, corpus);

      const stagingRows: AuctionLotImportStagingRow[] = partialRows.map((p) => {
        const match =
          p.itemId == null
            ? (matchByNormalized.get(
                normalizeFuzzyText(p.row.data.materialName),
              ) ?? null)
            : null;
        return {
          rowNumber: p.row.rowNumber,
          lotNumber: p.row.data.lotNumber.trim(),
          materialLiftingDays: p.row.data.materialLiftingDays ?? null,
          plantLocationId: p.plantLocationId,
          materialLocationId: p.materialLocationId,
          gstPercentage: p.row.data.gstPercentage as 0 | 5 | 12 | 18 | 28,
          tcsPercentage: p.row.data.tcsPercentage,
          startBidPrice: p.row.data.startBidPrice,
          bidLimit: p.row.data.bidLimit,
          bidIncrement: p.row.data.bidIncrement,
          lotStartTime: p.row.data.lotStartTime,
          lotEndTime: p.row.data.lotEndTime,
          loadingScope: p.row.data.loadingScope,
          displayOrder: p.row.data.displayOrder,
          remark: p.row.data.remark,
          quantity: p.row.data.quantity,
          uomCode: p.row.data.uom,
          uomId: p.uomId,
          benchmarkMaterial: p.row.data.benchmarkMaterial ?? null,
          benchmarkMaterialLocationId: p.benchmarkMaterialLocationId,
          materialName: p.row.data.materialName,
          materialDescription: p.row.data.materialDescription,
          itemId: p.itemId,
          existingLotId:
            p.existing?.isActive === true ? (p.existing.id ?? null) : null,
          match,
        };
      });

      const stagingId = await createLotImportStagingSession({
        auctionId,
        clientId,
        createdBy: userId,
        rows: stagingRows,
      });

      onProgress?.({
        phase: "parse",
        processed: stagingRows.length,
        total: stagingRows.length,
        percent: 100,
        label: "Review item matches",
      });

      const capped = capImportIssues(issues);
      return {
        kind: "needsReview",
        review: {
          stagingId,
          parsed: stagingRows.length,
          failed: failedCount,
          skipped: skippedCount,
          total: stagingRows.length + failedCount + skippedCount,
          issues: capped.issues,
          issuesTruncated: capped.issuesTruncated,
        },
      };
    }

    // No staging needed: if everything failed validation, return counts without upsert.
    if (partialRows.length === 0) {
      const capped = capImportIssues(issues);
      return {
        kind: "imported",
        result: {
          imported: 0,
          withdrawn: 0,
          failed: failedCount,
          skipped: skippedCount,
          issues: capped.issues,
          issuesTruncated: capped.issuesTruncated,
        },
      };
    }

    const resolvedRows: ResolvedImportRow[] = partialRows.map((p) => ({
      rowNumber: p.row.rowNumber,
      lotNumber: p.row.data.lotNumber.trim(),
      materialLiftingDays: p.row.data.materialLiftingDays ?? null,
      plantLocationId: p.plantLocationId,
      materialLocationId: p.materialLocationId,
      gstPercentage: p.row.data.gstPercentage as 0 | 5 | 12 | 18 | 28,
      tcsPercentage: p.row.data.tcsPercentage,
      startBidPrice: p.row.data.startBidPrice,
      bidLimit: p.row.data.bidLimit,
      bidIncrement: p.row.data.bidIncrement,
      lotStartTime: p.row.data.lotStartTime,
      lotEndTime: p.row.data.lotEndTime,
      loadingScope: p.row.data.loadingScope,
      displayOrder: p.row.data.displayOrder,
      remark: p.row.data.remark,
      quantity: p.row.data.quantity,
      uomCode: p.row.data.uom,
      uomId: p.uomId,
      benchmarkMaterialLocationId: p.benchmarkMaterialLocationId,
      materialName: p.row.data.materialName,
      materialDescription: p.row.data.materialDescription,
      itemId: p.itemId!,
      existing: p.existing,
    }));

    const { imported, withdrawn } = await upsertResolvedLots({
      auctionId,
      clientId,
      userId,
      resolvedRows,
      existingByDisplayOrder,
      issues,
      onProgress,
    });

    const capped = capImportIssues(issues);
    return {
      kind: "imported",
      result: {
        imported,
        withdrawn,
        failed: issues.filter((i) => i.kind === "error").length,
        skipped: issues.filter((i) => i.kind === "skipped").length,
        issues: capped.issues,
        issuesTruncated: capped.issuesTruncated,
      },
    };
  }

  async confirmStagingImport(
    auctionId: number,
    stagingId: string,
    userId: number,
    auctionDate: string,
    selections: {
      rowNumber: number;
      itemId: number;
      benchmarkMaterialLocationId?: number | null;
    }[],
    onProgress?: (update: AuctionLotImportProgress) => void,
  ): Promise<AuctionLotImportResult> {
    const { clientId, rows } = await loadStagingPayloadForConfirm(
      auctionId,
      stagingId,
      userId,
    );

    const [[auctionRow], itemIds, benchmarkMap] = await Promise.all([
      db
        .select({ publishedAt: auctions.publishedAt })
        .from(auctions)
        .where(eq(auctions.id, auctionId))
        .limit(1),
      pgLoadClientItemIdSet(clientId),
      pgLoadBenchmarkComboLabelMap(),
    ]);
    const validBenchmarkIds = new Set(benchmarkMap.values());
    const selectionByRow = new Map(
      selections.map((s) => [s.rowNumber, s]),
    );

    for (const row of rows) {
      const selection = selectionByRow.get(row.rowNumber);
      const chosen =
        row.itemId ??
        selection?.itemId ??
        row.match?.selectedItemId ??
        null;
      if (chosen == null || !itemIds.has(chosen)) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.LOT_IMPORT_SELECT_ALL_ITEMS,
        );
      }

      if (
        selection &&
        "benchmarkMaterialLocationId" in selection &&
        selection.benchmarkMaterialLocationId != null &&
        !validBenchmarkIds.has(selection.benchmarkMaterialLocationId)
      ) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.LOT_IMPORT_UNKNOWN_BENCHMARK,
        );
      }

      const scheduleErrors = collectLotWriteScheduleErrors(
        row.lotStartTime,
        row.lotEndTime,
        auctionDate,
        undefined,
        auctionRow?.publishedAt,
      );
      if (scheduleErrors) {
        const first =
          scheduleErrors.lotStartTime?.[0] ??
          scheduleErrors.lotEndTime?.[0] ??
          AuctionsValidationMessages.LOT_TIME_INVALID;
        throw new AuctionValidationError(first, scheduleErrors);
      }
    }

    const existingByDisplayOrder =
      await pgLoadExistingLotsByDisplayOrder(auctionId);
    const issues: ImportRowIssue[] = [];

    const resolvedRows: ResolvedImportRow[] = rows.map((row) => {
      const selection = selectionByRow.get(row.rowNumber);
      const itemId =
        row.itemId ??
        selection?.itemId ??
        row.match?.selectedItemId!;
      const benchmarkMaterialLocationId =
        selection && "benchmarkMaterialLocationId" in selection
          ? (selection.benchmarkMaterialLocationId ?? null)
          : row.benchmarkMaterialLocationId;
      const displayOrderKey = normalizeDisplayOrderKey(row.displayOrder);
      return {
        rowNumber: row.rowNumber,
        lotNumber: row.lotNumber,
        materialLiftingDays: row.materialLiftingDays,
        plantLocationId: row.plantLocationId,
        materialLocationId: row.materialLocationId,
        gstPercentage: row.gstPercentage,
        tcsPercentage: row.tcsPercentage,
        startBidPrice: row.startBidPrice,
        bidLimit: row.bidLimit,
        bidIncrement: row.bidIncrement,
        lotStartTime: row.lotStartTime,
        lotEndTime: row.lotEndTime,
        loadingScope: row.loadingScope,
        displayOrder: row.displayOrder,
        remark: row.remark,
        quantity: row.quantity,
        uomCode: row.uomCode,
        uomId: row.uomId,
        benchmarkMaterialLocationId,
        materialName: row.materialName,
        materialDescription: row.materialDescription,
        itemId,
        existing: existingByDisplayOrder.get(displayOrderKey) ?? null,
      };
    });

    onProgress?.({
      phase: "import",
      processed: 0,
      total: resolvedRows.length,
      percent: 10,
      label: "Importing lots",
    });

    const { imported, withdrawn } = await upsertResolvedLots({
      auctionId,
      clientId,
      userId,
      resolvedRows,
      existingByDisplayOrder,
      issues,
      onProgress,
    });

    await deleteLotImportStagingSession(stagingId);

    const capped = capImportIssues(issues);
    return {
      imported,
      withdrawn,
      failed: issues.filter((i) => i.kind === "error").length,
      skipped: issues.filter((i) => i.kind === "skipped").length,
      issues: capped.issues,
      issuesTruncated: capped.issuesTruncated,
    };
  }
}

export const auctionLotImportService = new AuctionLotImportService();

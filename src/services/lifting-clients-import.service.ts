import {
  LiftingClientsImportUiMessages,
  LiftingClientsSuccessMessages,
  LiftingClientsValidationMessages,
  formatImportFieldErrors,
} from "@auctionit/messages/lifting-clients";
import {
  LIFTING_CLIENTS_IMPORT_BATCH_SIZE,
  LIFTING_CLIENTS_IMPORT_MAX_ISSUES_IN_RESPONSE,
  LIFTING_CLIENTS_IMPORT_MAX_ROWS,
} from "../lib/lifting-clients-import-constants.js";
import type { ParsedLiftingClientsImportRow } from "../lib/lifting-clients-import-parse.js";
import type {
  ImportRowIssue,
  LiftingClientsImportProgress,
  LiftingClientsImportResult,
  LiftingClientsImportScope,
} from "../lib/lifting-clients-import-types.js";
import type {
  LiftingClientsImportBatchInput,
  LiftingClientsImportRowInput,
} from "../lib/lifting-clients-import-schema.js";
import {
  capIssues,
  chunkArray,
  clampPercent,
  schemaErrorsToIssues,
} from "../lib/import/service-utils.js";
import { parseLiftingClientsImportXlsxBuffer } from "../lib/parse-lifting-clients-import-buffer.js";
import {
  LiftingClientValidationError,
  LiftingLotNotFoundError,
  parseLotId,
} from "../lib/lifting-lot-id.js";
import {
  liftingClientsService,
  type LiftingClientLogInput,
} from "./lifting-clients.service.js";
import { DEFAULT_LIFTING_CLIENT_DISPOSITION_ID } from "../lib/lifting-client-status.js";

export type LiftingClientsImportRowError = {
  rowNumber: number;
  code: string;
  message: string;
};

export type CommitLiftingClientsImportBatchResult = {
  imported: number;
  failed: number;
  rowErrors: LiftingClientsImportRowError[];
};

function parseSchemaIssues(
  rowErrors: { rowNumber: number; fieldErrors: Record<string, string[]> }[],
): ImportRowIssue[] {
  return schemaErrorsToIssues(rowErrors, (fieldErrors) =>
    formatImportFieldErrors(fieldErrors) ||
    LiftingClientsValidationMessages.VALIDATION_FAILED,
  );
}

function capImportIssues(issues: ImportRowIssue[]) {
  return capIssues(issues, LIFTING_CLIENTS_IMPORT_MAX_ISSUES_IN_RESPONSE);
}

function dedupeRowsByLotId(rows: ParsedLiftingClientsImportRow[]): {
  unique: ParsedLiftingClientsImportRow[];
  skippedIssues: ImportRowIssue[];
} {
  const byLotId = new Map<string, ParsedLiftingClientsImportRow>();
  const skippedIssues: ImportRowIssue[] = [];

  for (const row of rows) {
    const lotId = row.data.lotId.trim();
    const existing = byLotId.get(lotId);
    if (existing) {
      if (row.rowNumber > existing.rowNumber) {
        skippedIssues.push({
          rowNumber: existing.rowNumber,
          kind: "skipped",
          reason: LiftingClientsValidationMessages.DUPLICATE_LOT_IN_FILE(
            row.rowNumber,
          ),
        });
        byLotId.set(lotId, row);
      } else {
        skippedIssues.push({
          rowNumber: row.rowNumber,
          kind: "skipped",
          reason: LiftingClientsValidationMessages.DUPLICATE_LOT_IN_FILE(
            existing.rowNumber,
          ),
        });
      }
      continue;
    }
    byLotId.set(lotId, row);
  }

  return {
    unique: [...byLotId.values()].sort((a, b) => a.rowNumber - b.rowNumber),
    skippedIssues,
  };
}

function buildScopeAuctionIds(auctionIds: number[]): Set<number> {
  return new Set(auctionIds);
}

function isLotInScope(
  clientId: number,
  auctionId: number,
  clientIds: number[],
  scopeAuctionIds: Set<number>,
): boolean {
  if (!clientIds.includes(clientId)) return false;
  return scopeAuctionIds.has(auctionId);
}

function toEntryInput(
  data: LiftingClientsImportRowInput,
): LiftingClientLogInput {
  return {
    liftedQty: data.liftedQty,
    liftedDate: data.liftedDate,
    dispositionStatus:
      data.dispositionStatus ?? DEFAULT_LIFTING_CLIENT_DISPOSITION_ID,
    remarks: data.remarks ?? "",
  };
}

export class LiftingClientsImportService {
  async runImportFromBuffer(
    buffer: ArrayBuffer | Buffer,
    scope: LiftingClientsImportScope,
    createdBy: number,
    onProgress: (update: LiftingClientsImportProgress) => void,
  ): Promise<LiftingClientsImportResult> {
    const allIssues: ImportRowIssue[] = [];

    onProgress({
      phase: "parse",
      processed: 0,
      total: 0,
      percent: 5,
      label: LiftingClientsImportUiMessages.READING,
    });

    const parsed = await parseLiftingClientsImportXlsxBuffer(buffer);
    const schemaIssues = parseSchemaIssues(parsed.rowErrors);
    allIssues.push(...schemaIssues);
    allIssues.push(...parsed.skippedIssues);

    const totalDataRows =
      parsed.rows.length +
      parsed.rowErrors.length +
      parsed.skippedIssues.length;

    if (totalDataRows === 0) {
      throw new Error(LiftingClientsValidationMessages.NO_DATA_ROWS);
    }

    if (parsed.rows.length > LIFTING_CLIENTS_IMPORT_MAX_ROWS) {
      throw new Error(
        LiftingClientsValidationMessages.ROW_LIMIT_EXCEEDED(
          LIFTING_CLIENTS_IMPORT_MAX_ROWS,
        ),
      );
    }

    onProgress({
      phase: "parse",
      processed: totalDataRows,
      total: totalDataRows,
      percent: 15,
      label: LiftingClientsImportUiMessages.PARSED_ROWS(totalDataRows),
    });

    if (parsed.rows.length === 0) {
      const failed = allIssues.filter((i) => i.kind === "error").length;
      const skipped = allIssues.filter((i) => i.kind === "skipped").length;
      const { issues, issuesTruncated } = capImportIssues(allIssues);
      return {
        imported: 0,
        failed,
        skipped,
        issues,
        issuesTruncated,
      };
    }

    const { unique, skippedIssues } = dedupeRowsByLotId(parsed.rows);
    allIssues.push(...skippedIssues);

    if (unique.length === 0) {
      const failed = allIssues.filter((i) => i.kind === "error").length;
      const skipped = allIssues.filter((i) => i.kind === "skipped").length;
      const { issues, issuesTruncated } = capImportIssues(allIssues);
      return {
        imported: 0,
        failed,
        skipped,
        issues,
        issuesTruncated,
      };
    }

    const batches = chunkArray(unique, LIFTING_CLIENTS_IMPORT_BATCH_SIZE);
    let imported = 0;
    let processedRows = 0;

    for (const batch of batches) {
      const result = await this.commitImportBatch(
        {
          clientIds: scope.clientIds,
          auctionIds: scope.auctionIds,
          rows: batch,
        },
        createdBy,
      );

      imported += result.imported;
      const failedRowNumbers = new Set(
        result.rowErrors.map((rowError) => rowError.rowNumber),
      );
      for (const rowError of result.rowErrors) {
        allIssues.push({
          rowNumber: rowError.rowNumber,
          kind: "error",
          reason: rowError.message,
        });
      }
      for (const row of batch) {
        if (failedRowNumbers.has(row.rowNumber)) continue;
        allIssues.push({
          rowNumber: row.rowNumber,
          kind: "uploaded",
          reason: LiftingClientsSuccessMessages.IMPORT_ROW_UPLOADED,
        });
      }

      processedRows += batch.length;
      onProgress({
        phase: "import",
        processed: processedRows,
        total: unique.length,
        percent: clampPercent(15 + (processedRows / unique.length) * 85),
        label: LiftingClientsImportUiMessages.IMPORTING_ROWS(
          processedRows,
          unique.length,
        ),
      });
    }

    const failed = allIssues.filter((i) => i.kind === "error").length;
    const skipped = allIssues.filter((i) => i.kind === "skipped").length;
    const { issues, issuesTruncated } = capImportIssues(allIssues);

    return {
      imported,
      failed,
      skipped,
      issues,
      issuesTruncated,
    };
  }

  async commitImportBatch(
    input: LiftingClientsImportBatchInput,
    createdBy: number,
  ): Promise<CommitLiftingClientsImportBatchResult> {
    const scopeAuctionIds = buildScopeAuctionIds(input.auctionIds);
    let imported = 0;
    let failed = 0;
    const rowErrors: LiftingClientsImportRowError[] = [];

    for (const row of input.rows) {
      const { rowNumber, data } = row;

      let lotId: number;
      try {
        lotId = parseLotId(data.lotId);
      } catch {
        failed += 1;
        rowErrors.push({
          rowNumber,
          code: "invalid_lot_id",
          message: LiftingClientsValidationMessages.INVALID_LOT_ID,
        });
        continue;
      }

      try {
        const lot = await liftingClientsService.getById(data.lotId);
        if (!lot) {
          failed += 1;
          rowErrors.push({
            rowNumber,
            code: "lot_not_found",
            message: LiftingClientsValidationMessages.LOT_NOT_FOUND_OR_NOT_APPROVED,
          });
          continue;
        }

        if (
          !isLotInScope(
            lot.clientId,
            lot.auctionId,
            input.clientIds,
            scopeAuctionIds,
          )
        ) {
          failed += 1;
          rowErrors.push({
            rowNumber,
            code: "out_of_scope",
            message: LiftingClientsValidationMessages.LOT_OUT_OF_SCOPE,
          });
          continue;
        }

        if (
          lot.auctionName.trim() !== data.auctionName.trim() ||
          lot.lotNumber.trim() !== data.lotNumber.trim()
        ) {
          failed += 1;
          rowErrors.push({
            rowNumber,
            code: "lot_identity_mismatch",
            message: LiftingClientsValidationMessages.AUCTION_LOT_MISMATCH,
          });
          continue;
        }

        await liftingClientsService.insertLiftingLog(
          lotId,
          toEntryInput(data),
          createdBy,
        );
        imported += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof LiftingClientValidationError) {
          rowErrors.push({
            rowNumber,
            code: err.field,
            message: err.message,
          });
          continue;
        }
        if (err instanceof LiftingLotNotFoundError) {
          rowErrors.push({
            rowNumber,
            code: "lot_not_found",
            message: err.message,
          });
          continue;
        }
        throw err;
      }
    }

    return {
      imported,
      failed,
      rowErrors,
    };
  }
}

export const liftingClientsImportService = new LiftingClientsImportService();

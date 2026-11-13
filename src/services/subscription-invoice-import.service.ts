import {
  buildSubscriptionInvoiceImportResultMessage,
  SubscriptionsInvoiceImportUiMessages,
  SubscriptionsSuccessMessages,
  SubscriptionsValidationMessages as M,
} from "@auctionit/messages/subscriptions";
import type { ImportRowIssue } from "@auctionit/xlsx-import/types";
import {
  SUB_INVOICE_IMPORT_MAX_ISSUES_IN_RESPONSE,
  SUB_INVOICE_IMPORT_MAX_PDF_BYTES,
  SUB_INVOICE_IMPORT_MAX_ROWS,
  SUB_INVOICE_IMPORT_SHEET,
  SUB_INVOICE_IMPORT_TEMPLATE_HEADERS,
} from "../lib/subscriptions/invoice-import-constants.js";
import {
  invoiceImportFieldErrorsToIssues,
  normalizePdfBasename,
  parseSubscriptionInvoiceImportXlsxBuffer,
} from "../lib/subscriptions/invoice-import-parse.js";
import type {
  SubscriptionInvoiceImportPdfFile,
  SubscriptionInvoiceImportProgress,
  SubscriptionInvoiceImportResult,
} from "../lib/subscriptions/invoice-import-types.js";
import {
  createImportWorkbook,
  workbookToBuffer,
} from "../lib/import/template-builder.js";
import { capIssues } from "../lib/import/service-utils.js";
import {
  SubscriptionValidationError,
  subscriptionsService,
} from "./subscriptions.service.js";

export async function buildSubscriptionInvoiceImportTemplateXlsx(): Promise<Buffer> {
  const { workbook } = createImportWorkbook({
    sheetName: SUB_INVOICE_IMPORT_SHEET,
    headers: SUB_INVOICE_IMPORT_TEMPLATE_HEADERS,
    creator: "AuctionIT Accounts",
  });
  return workbookToBuffer(workbook);
}

export function buildSubscriptionInvoiceImportTemplateFilename(): string {
  return "subscriptions-invoices-import.xlsx";
}

function buildPdfMap(
  pdfs: SubscriptionInvoiceImportPdfFile[],
):
  | { ok: true; map: Map<string, SubscriptionInvoiceImportPdfFile> }
  | { ok: false; message: string } {
  const map = new Map<string, SubscriptionInvoiceImportPdfFile>();
  const maxMb = Math.round(SUB_INVOICE_IMPORT_MAX_PDF_BYTES / (1024 * 1024));

  for (const pdf of pdfs) {
    const key = normalizePdfBasename(pdf.originalname);
    if (!key) continue;
    if (map.has(key)) {
      return {
        ok: false,
        message: M.INVOICE_IMPORT_PDF_DUPLICATE(pdf.originalname),
      };
    }
    if (pdf.size > SUB_INVOICE_IMPORT_MAX_PDF_BYTES) {
      return { ok: false, message: M.INVOICE_IMPORT_PDF_TOO_LARGE(maxMb) };
    }
    map.set(key, pdf);
  }

  if (map.size === 0) {
    return { ok: false, message: M.INVOICE_IMPORT_PDFS_REQUIRED };
  }

  return { ok: true, map };
}

export async function runSubscriptionInvoiceImportFromBuffers(
  xlsxBuffer: ArrayBuffer | Buffer,
  pdfs: SubscriptionInvoiceImportPdfFile[],
  userId: number,
  onProgress?: (update: SubscriptionInvoiceImportProgress) => void,
): Promise<SubscriptionInvoiceImportResult> {
  const emit = onProgress ?? (() => {});

  emit({
    phase: "parse",
    processed: 0,
    total: 0,
    percent: 5,
    label: SubscriptionsInvoiceImportUiMessages.READING,
  });

  const pdfMapResult = buildPdfMap(pdfs);
  if (!pdfMapResult.ok) {
    return {
      total: 0,
      imported: 0,
      failed: 1,
      skipped: 0,
      message: pdfMapResult.message,
      issues: [
        {
          rowNumber: 1,
          kind: "error",
          reason: pdfMapResult.message,
        },
      ],
      issuesTruncated: false,
    };
  }
  const pdfMap = pdfMapResult.map;
  const usedPdfKeys = new Set<string>();

  const parsed = await parseSubscriptionInvoiceImportXlsxBuffer(xlsxBuffer);

  if (parsed.headerError) {
    return {
      total: 0,
      imported: 0,
      failed: 1,
      skipped: 0,
      message: parsed.headerError,
      issues: [
        {
          rowNumber: 1,
          kind: "error",
          reason: parsed.headerError,
        },
      ],
      issuesTruncated: false,
    };
  }

  if (parsed.tooManyRows) {
    const reason = M.INVOICE_IMPORT_ROW_LIMIT_EXCEEDED(SUB_INVOICE_IMPORT_MAX_ROWS);
    return {
      total: 0,
      imported: 0,
      failed: 1,
      skipped: 0,
      message: reason,
      issues: [{ rowNumber: 1, kind: "error", reason }],
      issuesTruncated: false,
    };
  }

  const schemaIssues = invoiceImportFieldErrorsToIssues(parsed.rowErrors);
  const allIssues: ImportRowIssue[] = [...schemaIssues];

  const validRows = parsed.rows;
  const totalCandidates = validRows.length + parsed.rowErrors.length;

  emit({
    phase: "parse",
    processed: totalCandidates,
    total: totalCandidates,
    percent: 20,
    label: SubscriptionsInvoiceImportUiMessages.PARSED_ROWS(totalCandidates),
  });

  if (validRows.length === 0 && parsed.rowErrors.length === 0) {
    return {
      total: 0,
      imported: 0,
      failed: 0,
      skipped: 0,
      message: M.INVOICE_IMPORT_NO_DATA_ROWS,
      issues: [],
      issuesTruncated: false,
    };
  }

  let imported = 0;
  let failed = schemaIssues.length;
  let skipped = 0;
  const totalToImport = validRows.length;

  for (let i = 0; i < validRows.length; i++) {
    const row = validRows[i]!;
    const {
      invoiceId,
      bidderId,
      invoiceNo,
      invoiceDate,
      invoicePdfFilename,
    } = row.data;

    emit({
      phase: "import",
      processed: i,
      total: totalToImport,
      percent: 20 + Math.round((i / Math.max(totalToImport, 1)) * 75),
      label: SubscriptionsInvoiceImportUiMessages.IMPORTING_ROWS(
        i,
        totalToImport,
      ),
    });

    try {
      const subscription = await subscriptionsService.getById(invoiceId);
      if (!subscription) {
        failed += 1;
        allIssues.push({
          rowNumber: row.rowNumber,
          kind: "error",
          reason: M.INVOICE_IMPORT_INVOICE_ID_NOT_FOUND,
          fieldErrors: {
            invoiceId: [M.INVOICE_IMPORT_INVOICE_ID_NOT_FOUND],
          },
        });
        continue;
      }

      if (subscription.bidderId !== bidderId) {
        failed += 1;
        allIssues.push({
          rowNumber: row.rowNumber,
          kind: "error",
          reason: M.INVOICE_IMPORT_COMBO_MISMATCH,
          fieldErrors: {
            bidderId: [M.INVOICE_IMPORT_COMBO_MISMATCH],
          },
        });
        continue;
      }

      const pdfKey = normalizePdfBasename(invoicePdfFilename);
      const pdfFile = pdfMap.get(pdfKey);
      if (!pdfFile) {
        failed += 1;
        allIssues.push({
          rowNumber: row.rowNumber,
          kind: "error",
          reason: M.INVOICE_IMPORT_PDF_MISSING(invoicePdfFilename),
          fieldErrors: {
            invoicePdfFilename: [
              M.INVOICE_IMPORT_PDF_MISSING(invoicePdfFilename),
            ],
          },
        });
        continue;
      }

      if (usedPdfKeys.has(pdfKey)) {
        failed += 1;
        allIssues.push({
          rowNumber: row.rowNumber,
          kind: "error",
          reason: M.INVOICE_IMPORT_PDF_ALREADY_USED(invoicePdfFilename),
          fieldErrors: {
            invoicePdfFilename: [
              M.INVOICE_IMPORT_PDF_ALREADY_USED(invoicePdfFilename),
            ],
          },
        });
        continue;
      }

      // Mark reserved before upload so a concurrent-looking second row cannot
      // reuse the same file if the first upload succeeds mid-loop.
      usedPdfKeys.add(pdfKey);

      await subscriptionsService.uploadInvoicePdf(
        invoiceId,
        { buffer: pdfFile.buffer },
        { invoiceNumber: invoiceNo, invoiceDate },
        userId,
      );

      imported += 1;
      allIssues.push({
        rowNumber: row.rowNumber,
        kind: "uploaded",
        reason: SubscriptionsSuccessMessages.INVOICE_IMPORT_ROW_UPLOADED,
      });
    } catch (e) {
      failed += 1;
      // If upload failed after reserving the PDF, release it so a later retry
      // row could use it — but within one file we keep it reserved to avoid
      // double-upload attempts on the same buffer for a broken row.
      const reason =
        e instanceof SubscriptionValidationError
          ? e.message
          : e instanceof Error
            ? e.message
            : M.INVOICE_IMPORT_ROW_INVALID;
      allIssues.push({
        rowNumber: row.rowNumber,
        kind: "error",
        reason,
      });
    }
  }

  // Extra uploaded PDFs that are not referenced in the sheet are ignored
  // (never uploaded, not counted as skipped).

  emit({
    phase: "import",
    processed: totalToImport,
    total: totalToImport,
    percent: 100,
    label: SubscriptionsInvoiceImportUiMessages.COMPLETE,
  });

  const capped = capIssues(
    allIssues,
    SUB_INVOICE_IMPORT_MAX_ISSUES_IN_RESPONSE,
  );
  const total = imported + failed + skipped;

  return {
    total,
    imported,
    failed,
    skipped,
    message: buildSubscriptionInvoiceImportResultMessage({
      imported,
      failed,
      skipped,
    }),
    issues: capped.issues,
    issuesTruncated: capped.issuesTruncated,
  };
}

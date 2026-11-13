import {
  buildServiceInvoicePaymentImportResultMessage,
  ServiceInvoicesPaymentImportUiMessages,
  ServiceInvoicesSuccessMessages,
  ServiceInvoicesValidationMessages as M,
} from "@auctionit/messages/service-invoices";
import type { ImportRowIssue } from "@auctionit/xlsx-import/types";
import {
  SI_PAYMENT_IMPORT_MAX_ISSUES_IN_RESPONSE,
  SI_PAYMENT_IMPORT_MAX_ROWS,
  SI_PAYMENT_IMPORT_SHEET,
  SI_PAYMENT_IMPORT_TEMPLATE_HEADERS,
} from "../lib/service-invoices/payment-import-constants.js";
import { paymentImportInvoicePairIssue } from "../lib/service-invoices/payment-import-match.js";
import {
  parseServiceInvoicePaymentImportXlsxBuffer,
  paymentImportFieldErrorsToIssues,
} from "../lib/service-invoices/payment-import-parse.js";
import type {
  ServiceInvoicePaymentImportProgress,
  ServiceInvoicePaymentImportResult,
} from "../lib/service-invoices/payment-import-types.js";
import {
  createImportWorkbook,
  workbookToBuffer,
} from "../lib/import/template-builder.js";
import { capIssues } from "../lib/import/service-utils.js";
import {
  assertPaymentWithinGrandTotal,
  insertPaymentLog,
  ServiceInvoicePaymentValidationError,
} from "./service-invoice-payment-logs.service.js";
import { serviceInvoicesService } from "./service-invoices.service.js";

function normalizeInvoiceNo(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export async function buildServiceInvoicePaymentImportTemplateXlsx(): Promise<Buffer> {
  const { workbook } = createImportWorkbook({
    sheetName: SI_PAYMENT_IMPORT_SHEET,
    headers: SI_PAYMENT_IMPORT_TEMPLATE_HEADERS,
    creator: "AuctionIT Accounts",
  });
  return workbookToBuffer(workbook);
}

export function buildServiceInvoicePaymentImportTemplateFilename(): string {
  return "service-invoices-payments-import.xlsx";
}

export async function runServiceInvoicePaymentImportFromBuffer(
  buffer: ArrayBuffer | Buffer,
  userId: number | undefined,
  onProgress?: (update: ServiceInvoicePaymentImportProgress) => void,
): Promise<ServiceInvoicePaymentImportResult> {
  const emit = onProgress ?? (() => {});

  emit({
    phase: "parse",
    processed: 0,
    total: 0,
    percent: 5,
    label: ServiceInvoicesPaymentImportUiMessages.READING,
  });

  const parsed = await parseServiceInvoicePaymentImportXlsxBuffer(buffer);

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
    const reason = M.PAYMENT_IMPORT_ROW_LIMIT_EXCEEDED(SI_PAYMENT_IMPORT_MAX_ROWS);
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

  const schemaIssues = paymentImportFieldErrorsToIssues(parsed.rowErrors);
  const allIssues: ImportRowIssue[] = [...schemaIssues];

  const validRows = parsed.rows;
  const totalCandidates = validRows.length + parsed.rowErrors.length;

  emit({
    phase: "parse",
    processed: totalCandidates,
    total: totalCandidates,
    percent: 20,
    label: ServiceInvoicesPaymentImportUiMessages.PARSED_ROWS(totalCandidates),
  });

  if (validRows.length === 0 && parsed.rowErrors.length === 0) {
    return {
      total: 0,
      imported: 0,
      failed: 0,
      skipped: 0,
      message: M.PAYMENT_IMPORT_NO_DATA_ROWS,
      issues: [],
      issuesTruncated: false,
    };
  }

  let imported = 0;
  let failed = schemaIssues.length;
  const totalToImport = validRows.length;

  for (let i = 0; i < validRows.length; i++) {
    const row = validRows[i]!;
    const { invoiceId, invoiceNo, paidAmount, paidAt } = row.data;

    emit({
      phase: "import",
      processed: i,
      total: totalToImport,
      percent: 20 + Math.round((i / Math.max(totalToImport, 1)) * 75),
      label: ServiceInvoicesPaymentImportUiMessages.IMPORTING_ROWS(
        i,
        totalToImport,
      ),
    });

    try {
      const invoice = await serviceInvoicesService.get(invoiceId);
      const normalizedInvoiceNo = normalizeInvoiceNo(invoiceNo);
      const numberMatches =
        invoice != null &&
        normalizeInvoiceNo(invoice.invoiceNumber) === normalizedInvoiceNo;
      const pairIssue = paymentImportInvoicePairIssue({
        invoiceFound: invoice != null,
        numberMatches,
      });

      if (!invoice || pairIssue === "id-not-found") {
        failed += 1;
        allIssues.push({
          rowNumber: row.rowNumber,
          kind: "error",
          reason: M.PAYMENT_IMPORT_INVOICE_ID_NOT_FOUND,
          fieldErrors: {
            invoiceId: [M.PAYMENT_IMPORT_INVOICE_ID_NOT_FOUND],
          },
        });
        continue;
      }

      if (pairIssue === "combo") {
        failed += 1;
        allIssues.push({
          rowNumber: row.rowNumber,
          kind: "error",
          reason: M.PAYMENT_IMPORT_COMBO_MISMATCH,
          fieldErrors: {
            invoiceNo: [M.PAYMENT_IMPORT_COMBO_MISMATCH],
          },
        });
        continue;
      }

      if (invoice.status !== "generated") {
        failed += 1;
        allIssues.push({
          rowNumber: row.rowNumber,
          kind: "error",
          reason: M.PAYMENT_ONLY_GENERATED,
          fieldErrors: {
            invoiceId: [M.PAYMENT_ONLY_GENERATED],
          },
        });
        continue;
      }

      // Sequential inserts sync aggregates, so each assert sees prior rows in this file.
      await assertPaymentWithinGrandTotal(
        invoiceId,
        invoice.grandTotal,
        paidAmount,
      );

      await insertPaymentLog(invoiceId, { paidAmount, paidAt }, userId);

      imported += 1;
      allIssues.push({
        rowNumber: row.rowNumber,
        kind: "uploaded",
        reason: ServiceInvoicesSuccessMessages.PAYMENT_IMPORT_ROW_UPLOADED,
      });
    } catch (e) {
      failed += 1;
      const reason =
        e instanceof ServiceInvoicePaymentValidationError
          ? e.message
          : e instanceof Error
            ? e.message
            : M.PAYMENT_IMPORT_ROW_INVALID;
      allIssues.push({
        rowNumber: row.rowNumber,
        kind: "error",
        reason,
      });
    }
  }

  emit({
    phase: "import",
    processed: totalToImport,
    total: totalToImport,
    percent: 100,
    label: ServiceInvoicesPaymentImportUiMessages.COMPLETE,
  });

  const capped = capIssues(allIssues, SI_PAYMENT_IMPORT_MAX_ISSUES_IN_RESPONSE);
  const total = imported + failed;

  return {
    total,
    imported,
    failed,
    skipped: 0,
    message: buildServiceInvoicePaymentImportResultMessage({
      imported,
      failed,
      skipped: 0,
    }),
    issues: capped.issues,
    issuesTruncated: capped.issuesTruncated,
  };
}

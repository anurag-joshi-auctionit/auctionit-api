import { SubscriptionsValidationMessages as M } from "@auctionit/messages/subscriptions";
import type { ImportRowIssue } from "@auctionit/xlsx-import/types";
import {
  castImportNumber,
  coerceImportCellString,
} from "@auctionit/xlsx-import/coerce";
import {
  buildHeaderIndexMap,
  isImportRowBlank,
} from "@auctionit/xlsx-import/headers";
import { readXlsxMatrix } from "@auctionit/xlsx-import/read-xlsx";
import {
  SUB_INVOICE_IMPORT_MAX_ROWS,
  SUB_INVOICE_IMPORT_SHEET,
  SUB_INVOICE_IMPORT_TEMPLATE_HEADERS,
} from "./invoice-import-constants.js";
import {
  subscriptionInvoiceImportRowSchema,
  type SubscriptionInvoiceImportRowInput,
} from "./invoice-import-schema.js";
import { istTodayDateOnly } from "./schemas.js";

export type ParsedSubscriptionInvoiceImportRow = {
  rowNumber: number;
  data: SubscriptionInvoiceImportRowInput;
};

export type SubscriptionInvoiceImportParseRowError = {
  rowNumber: number;
  fieldErrors: Record<string, string[]>;
};

export type ParseSubscriptionInvoiceImportResult = {
  rows: ParsedSubscriptionInvoiceImportRow[];
  rowErrors: SubscriptionInvoiceImportParseRowError[];
  headerError?: string;
  tooManyRows?: boolean;
};

/** Basename only, lowercased — used to match Excel ↔ uploaded PDFs. */
export function normalizePdfBasename(name: string): string {
  const trimmed = name.trim();
  const base =
    trimmed.replace(/\\/g, "/").split("/").pop()?.trim() || trimmed;
  return base.toLowerCase();
}

function castImportRowFields(obj: Record<string, unknown>):
  | { ok: true; data: SubscriptionInvoiceImportRowInput }
  | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};

  const invoiceIdRaw = castImportNumber(obj.invoiceId);
  if (invoiceIdRaw == null) {
    fieldErrors.invoiceId = [M.INVOICE_IMPORT_INVOICE_ID_REQUIRED];
  } else if (!Number.isInteger(invoiceIdRaw) || invoiceIdRaw <= 0) {
    fieldErrors.invoiceId = [M.INVOICE_IMPORT_INVOICE_ID_INVALID];
  }

  const bidderIdRaw = castImportNumber(obj.bidderId);
  if (bidderIdRaw == null) {
    fieldErrors.bidderId = [M.INVOICE_IMPORT_BIDDER_ID_REQUIRED];
  } else if (!Number.isInteger(bidderIdRaw) || bidderIdRaw <= 0) {
    fieldErrors.bidderId = [M.INVOICE_IMPORT_BIDDER_ID_INVALID];
  }

  const invoiceNo = coerceImportCellString(obj.invoiceNo);

  const pdfFilename = coerceImportCellString(obj.invoicePdfFilename);
  if (!pdfFilename) {
    fieldErrors.invoicePdfFilename = [M.INVOICE_IMPORT_PDF_FILENAME_REQUIRED];
  }

  const candidate = {
    invoiceId: invoiceIdRaw ?? Number.NaN,
    bidderId: bidderIdRaw ?? Number.NaN,
    invoiceNo: invoiceNo || "",
    // Invoice date is not on the sheet — default to IST today (same as single upload).
    invoiceDate: istTodayDateOnly(),
    invoicePdfFilename: pdfFilename || "",
  };

  const parsed = subscriptionInvoiceImportRowSchema.safeParse(candidate);
  if (!parsed.success) {
    const zodErrors: Record<string, string[]> = { ...fieldErrors };
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".") || "_root";
      if (!zodErrors[path]) zodErrors[path] = [];
      if (!zodErrors[path].includes(issue.message)) {
        zodErrors[path].push(issue.message);
      }
    }
    return { ok: false, fieldErrors: zodErrors };
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return { ok: true, data: parsed.data };
}

export function parseSubscriptionInvoiceImportSheetRows(
  matrix: unknown[][],
): ParseSubscriptionInvoiceImportResult {
  if (matrix.length === 0) {
    return {
      rows: [],
      rowErrors: [],
      headerError: M.INVOICE_IMPORT_SPREADSHEET_EMPTY,
    };
  }

  if (matrix.length < 2) {
    return { rows: [], rowErrors: [] };
  }

  const headerRow = matrix[0] ?? [];
  const { columnIndexByKey, missingLabels } = buildHeaderIndexMap(
    headerRow,
    SUB_INVOICE_IMPORT_TEMPLATE_HEADERS,
  );

  if (missingLabels.length > 0) {
    return {
      rows: [],
      rowErrors: [],
      headerError: M.INVOICE_IMPORT_HEADER_MISSING(missingLabels.join(", ")),
    };
  }

  const dataRowCount = matrix.length - 1;
  if (dataRowCount > SUB_INVOICE_IMPORT_MAX_ROWS) {
    return { rows: [], rowErrors: [], tooManyRows: true };
  }

  const rows: ParsedSubscriptionInvoiceImportRow[] = [];
  const rowErrors: SubscriptionInvoiceImportParseRowError[] = [];

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
    const cast = castImportRowFields(obj);
    if (!cast.ok) {
      rowErrors.push({ rowNumber, fieldErrors: cast.fieldErrors });
      continue;
    }

    rows.push({ rowNumber, data: cast.data });
  }

  return { rows, rowErrors };
}

export async function parseSubscriptionInvoiceImportXlsxBuffer(
  buffer: ArrayBuffer | Buffer,
): Promise<ParseSubscriptionInvoiceImportResult> {
  const { matrix } = await readXlsxMatrix(buffer, {
    preferredSheetNames: [SUB_INVOICE_IMPORT_SHEET],
  });
  return parseSubscriptionInvoiceImportSheetRows(matrix);
}

export function invoiceImportFieldErrorsToIssues(
  rowErrors: SubscriptionInvoiceImportParseRowError[],
): ImportRowIssue[] {
  return rowErrors.map((err) => {
    const parts: string[] = [];
    for (const [field, messages] of Object.entries(err.fieldErrors)) {
      for (const message of messages) {
        parts.push(field === "_root" ? message : `${field}: ${message}`);
      }
    }
    return {
      rowNumber: err.rowNumber,
      kind: "error" as const,
      reason: parts.join("; ") || M.INVOICE_IMPORT_ROW_INVALID,
      fieldErrors: err.fieldErrors,
    };
  });
}

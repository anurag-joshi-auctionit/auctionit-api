import { ServiceInvoicesValidationMessages as M } from "@auctionit/messages/service-invoices";
import type { ImportRowIssue } from "@auctionit/xlsx-import/types";
import {
  castImportDateToIso,
  isIsoDateString,
} from "@auctionit/xlsx-import/date";
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
  SI_PAYMENT_IMPORT_MAX_ROWS,
  SI_PAYMENT_IMPORT_SHEET,
  SI_PAYMENT_IMPORT_TEMPLATE_HEADERS,
} from "./payment-import-constants.js";
import {
  serviceInvoicePaymentImportRowSchema,
  type ServiceInvoicePaymentImportRowInput,
} from "./payment-import-schema.js";
import { istTodayDateOnly } from "./schemas.js";

export type ParsedServiceInvoicePaymentImportRow = {
  rowNumber: number;
  data: ServiceInvoicePaymentImportRowInput;
};

export type ServiceInvoicePaymentImportParseRowError = {
  rowNumber: number;
  fieldErrors: Record<string, string[]>;
};

export type ParseServiceInvoicePaymentImportResult = {
  rows: ParsedServiceInvoicePaymentImportRow[];
  rowErrors: ServiceInvoicePaymentImportParseRowError[];
  headerError?: string;
  tooManyRows?: boolean;
};

function castImportRowFields(obj: Record<string, unknown>):
  | { ok: true; data: ServiceInvoicePaymentImportRowInput }
  | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};

  const invoiceIdCell = coerceImportCellString(obj.invoiceId);
  const invoiceIdRaw = castImportNumber(obj.invoiceId);
  if (!invoiceIdCell) {
    fieldErrors.invoiceId = [M.PAYMENT_IMPORT_INVOICE_ID_REQUIRED];
  } else if (
    invoiceIdRaw == null ||
    !Number.isInteger(invoiceIdRaw) ||
    invoiceIdRaw <= 0
  ) {
    fieldErrors.invoiceId = [M.PAYMENT_IMPORT_INVOICE_ID_INVALID];
  }

  const invoiceNo = coerceImportCellString(obj.invoiceNo);
  if (!invoiceNo) {
    fieldErrors.invoiceNo = [M.PAYMENT_IMPORT_INVOICE_NO_REQUIRED];
  }

  const paidAmountCell = coerceImportCellString(obj.paidAmount);
  const paidAmountRaw = castImportNumber(obj.paidAmount);
  if (!paidAmountCell) {
    fieldErrors.paidAmount = [M.PAID_AMOUNT_REQUIRED];
  } else if (paidAmountRaw == null) {
    fieldErrors.paidAmount = [M.PAID_AMOUNT_INVALID];
  } else if (!(paidAmountRaw > 0)) {
    fieldErrors.paidAmount = [M.PAID_AMOUNT_POSITIVE];
  }

  let paidAtIso = "";
  const dateCast = castImportDateToIso(obj.paidAt);
  if (!dateCast.ok) {
    // Map shared date-cast failures to service-invoice copy (not lifting-clients).
    fieldErrors.paidAt = [M.PAID_AT_INVALID];
  } else if (!dateCast.iso) {
    fieldErrors.paidAt = [M.PAID_AT_REQUIRED];
  } else if (!isIsoDateString(dateCast.iso)) {
    fieldErrors.paidAt = [M.PAID_AT_INVALID];
  } else if (dateCast.iso > istTodayDateOnly()) {
    fieldErrors.paidAt = [M.PAID_AT_FUTURE];
  } else {
    paidAtIso = dateCast.iso;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const candidate = {
    invoiceId: invoiceIdRaw as number,
    invoiceNo,
    paidAmount: paidAmountRaw as number,
    paidAt: paidAtIso,
  };

  const parsed = serviceInvoicePaymentImportRowSchema.safeParse(candidate);
  if (!parsed.success) {
    const zodErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".") || "_root";
      if (!zodErrors[path]) zodErrors[path] = [];
      zodErrors[path].push(issue.message);
    }
    return { ok: false, fieldErrors: zodErrors };
  }

  return { ok: true, data: parsed.data };
}

export function parseServiceInvoicePaymentImportSheetRows(
  matrix: unknown[][],
): ParseServiceInvoicePaymentImportResult {
  if (matrix.length === 0) {
    return {
      rows: [],
      rowErrors: [],
      headerError: M.PAYMENT_IMPORT_SPREADSHEET_EMPTY,
    };
  }

  if (matrix.length < 2) {
    return { rows: [], rowErrors: [] };
  }

  const headerRow = matrix[0] ?? [];
  const { columnIndexByKey, missingLabels } = buildHeaderIndexMap(
    headerRow,
    SI_PAYMENT_IMPORT_TEMPLATE_HEADERS,
  );

  if (missingLabels.length > 0) {
    return {
      rows: [],
      rowErrors: [],
      headerError: M.PAYMENT_IMPORT_HEADER_MISSING(missingLabels.join(", ")),
    };
  }

  const dataRowCount = matrix.length - 1;
  if (dataRowCount > SI_PAYMENT_IMPORT_MAX_ROWS) {
    return { rows: [], rowErrors: [], tooManyRows: true };
  }

  const rows: ParsedServiceInvoicePaymentImportRow[] = [];
  const rowErrors: ServiceInvoicePaymentImportParseRowError[] = [];

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

export async function parseServiceInvoicePaymentImportXlsxBuffer(
  buffer: ArrayBuffer | Buffer,
): Promise<ParseServiceInvoicePaymentImportResult> {
  const { matrix } = await readXlsxMatrix(buffer, {
    preferredSheetNames: [SI_PAYMENT_IMPORT_SHEET],
  });
  return parseServiceInvoicePaymentImportSheetRows(matrix);
}

export function paymentImportFieldErrorsToIssues(
  rowErrors: ServiceInvoicePaymentImportParseRowError[],
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
      reason: parts.join("; ") || M.PAYMENT_IMPORT_ROW_INVALID,
      fieldErrors: err.fieldErrors,
    };
  });
}

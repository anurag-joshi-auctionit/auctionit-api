import { ServiceInvoicesValidationMessages as M } from "@auctionit/messages/service-invoices";
import {
  buildHeaderIndexMap,
  cellByHeaderKey,
  isImportRowBlank,
  normalizeImportHeader,
} from "@auctionit/xlsx-import/headers";
import { castImportNumber, coerceImportCellString } from "@auctionit/xlsx-import/coerce";
import {
  castImportDateToIso,
  type CastImportDateResult,
} from "@auctionit/xlsx-import/date";
import { readXlsxMatrix } from "@auctionit/xlsx-import/read-xlsx";
import {
  SI_ANNEXURE_AMOUNT_TOLERANCE,
  SI_ANNEXURE_BIDDER_HEADER,
  SI_ANNEXURE_FIXED_REQUIRED_HEADERS,
  SI_ANNEXURE_MAX_ROWS,
  SI_ANNEXURE_PRICE_HEADER,
  SI_ANNEXURE_SHEET,
  type SiAnnexureParseRank,
} from "./annexure-constants.js";
import { WINNER_LABEL } from "@auctionit/lib/winner-rank";
import type {
  ServiceInvoiceAnnexureLine,
  ServiceInvoiceAnnexureParseIssue,
  ServiceInvoiceAnnexureParseResult,
} from "./annexure-types.js";
import { aggregateAnnexureTotals } from "./annexure-totals.js";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const MONTH_NAME_DATE_RE =
  /^(\d{1,2})[/.\-]([A-Za-z]{3,9})[/.\-](\d{2,4})$/;

const MONTH_NAME_TO_NUM: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function normalizeYear(y: number): number {
  if (y >= 100) return y;
  return y >= 70 ? 1900 + y : 2000 + y;
}

/** Shared date cast plus legacy `12/Jan/2024` annexure labels. */
function castAnnexureDateToIso(value: unknown): CastImportDateResult {
  const primary = castImportDateToIso(value);
  if (primary.ok) return primary;

  const text = String(value ?? "").trim();
  const match = MONTH_NAME_DATE_RE.exec(text);
  if (!match) return primary;

  const day = Number(match[1]);
  const month = MONTH_NAME_TO_NUM[match[2]!.toLowerCase()];
  const year = normalizeYear(Number(match[3]));
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) {
    return primary;
  }
  const dt = new Date(year, month - 1, day);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day
  ) {
    return primary;
  }
  return { ok: true, iso: `${year}-${pad2(month)}-${pad2(day)}` };
}

/**
 * Legacy AuctionIT5.0 annexure header labels → current template labels.
 * Normalized keys (see {@link normalizeImportHeader}).
 */
const LEGACY_HEADER_ALIASES: Record<string, string> = {
  "auction number": "Auction No.",
  "auction no": "Auction No.",
  // Truncated first letter seen in some seeded workbooks ("uction Number").
  "uction number": "Auction No.",
  "lifted qty": "Lifted Qty.",
  "highest price": SI_ANNEXURE_PRICE_HEADER,
  "party (h1)": SI_ANNEXURE_BIDDER_HEADER,
  "lowest price": SI_ANNEXURE_PRICE_HEADER,
  "party (l1)": SI_ANNEXURE_BIDDER_HEADER,
  "party (winning)": SI_ANNEXURE_BIDDER_HEADER,
  "winning price": SI_ANNEXURE_PRICE_HEADER,
  "winning bidder": SI_ANNEXURE_BIDDER_HEADER,
};

function aliasHeaderRow(headerRow: unknown[]): unknown[] {
  return headerRow.map((cell) => {
    const normalized = normalizeImportHeader(cell);
    return LEGACY_HEADER_ALIASES[normalized] ?? cell;
  });
}

function findHeaderIndex(headerRow: unknown[], label: string): number {
  const target = normalizeImportHeader(label);
  return headerRow.findIndex((cell) => normalizeImportHeader(cell) === target);
}

function headerHasAny(headerRow: unknown[], labels: string[]): boolean {
  return labels.some((label) => findHeaderIndex(headerRow, label) >= 0);
}

/** Tax-invoice style workbooks used by some clients instead of auction annexures. */
function isTaxInvoiceStyleHeader(headerRow: unknown[]): boolean {
  return (
    headerHasAny(headerRow, ["Tax Invoice No.", "Sold to Party Name"]) &&
    headerHasAny(headerRow, ["Rate"]) &&
    headerHasAny(headerRow, ["Amount"]) &&
    headerHasAny(headerRow, ["Lifted Qty", "Lifted Qty.", "Billed Quantity"])
  );
}

/**
 * Resolve Winning Price/Bidder columns, or a single legacy H1 / L1 / H1/L1 pair.
 * Call after {@link aliasHeaderRow} so legacy Highest Price / Party (H1) resolve.
 */
function resolveRankColumns(headerRow: unknown[]):
  | { ok: true; rank: SiAnnexureParseRank; priceKey: string; bidderKey: string }
  | { ok: false; message: string } {
  const winningPrice = findHeaderIndex(headerRow, SI_ANNEXURE_PRICE_HEADER);
  const winningBidder = findHeaderIndex(headerRow, SI_ANNEXURE_BIDDER_HEADER);
  const h1Price = findHeaderIndex(headerRow, "H1 Price");
  const l1Price = findHeaderIndex(headerRow, "L1 Price");
  const mixedPrice = findHeaderIndex(headerRow, "H1/L1 Price");
  const h1Bidder = findHeaderIndex(headerRow, "H1 Bidder");
  const l1Bidder = findHeaderIndex(headerRow, "L1 Bidder");
  const mixedBidder = findHeaderIndex(headerRow, "H1/L1 Bidder");

  const hasWinning = winningPrice >= 0 || winningBidder >= 0;
  const hasH1 = h1Price >= 0 || h1Bidder >= 0;
  const hasL1 = l1Price >= 0 || l1Bidder >= 0;
  const hasMixed = mixedPrice >= 0 || mixedBidder >= 0;

  const rankCount =
    (hasWinning ? 1 : 0) +
    (hasH1 ? 1 : 0) +
    (hasL1 ? 1 : 0) +
    (hasMixed ? 1 : 0);
  if (rankCount > 1) {
    return { ok: false, message: M.ANNEXURE_RANK_HEADERS_MIXED };
  }

  if (hasWinning) {
    if (winningPrice < 0 || winningBidder < 0) {
      return {
        ok: false,
        message: M.ANNEXURE_RANK_HEADERS_INCOMPLETE(WINNER_LABEL),
      };
    }
    return {
      ok: true,
      rank: WINNER_LABEL,
      priceKey: SI_ANNEXURE_PRICE_HEADER,
      bidderKey: SI_ANNEXURE_BIDDER_HEADER,
    };
  }

  if (hasH1) {
    if (h1Price < 0 || h1Bidder < 0) {
      return { ok: false, message: M.ANNEXURE_RANK_HEADERS_INCOMPLETE("H1") };
    }
    return {
      ok: true,
      rank: "H1",
      priceKey: "H1 Price",
      bidderKey: "H1 Bidder",
    };
  }

  if (hasL1) {
    if (l1Price < 0 || l1Bidder < 0) {
      return { ok: false, message: M.ANNEXURE_RANK_HEADERS_INCOMPLETE("L1") };
    }
    return {
      ok: true,
      rank: "L1",
      priceKey: "L1 Price",
      bidderKey: "L1 Bidder",
    };
  }

  if (hasMixed) {
    if (mixedPrice < 0 || mixedBidder < 0) {
      return {
        ok: false,
        message: M.ANNEXURE_RANK_HEADERS_INCOMPLETE("H1/L1"),
      };
    }
    return {
      ok: true,
      rank: "H1/L1",
      priceKey: "H1/L1 Price",
      bidderKey: "H1/L1 Bidder",
    };
  }

  return {
    ok: false,
    message: M.ANNEXURE_HEADER_MISSING(
      `${SI_ANNEXURE_PRICE_HEADER}, ${SI_ANNEXURE_BIDDER_HEADER}`,
    ),
  };
}

function finishParse(opts: {
  candidateLines: ServiceInvoiceAnnexureLine[];
  issues: ServiceInvoiceAnnexureParseIssue[];
  blankSkipped: number;
}): ServiceInvoiceAnnexureParseResult {
  const { candidateLines, issues, blankSkipped } = opts;

  if (candidateLines.length > SI_ANNEXURE_MAX_ROWS) {
    return {
      imported: 0,
      failed: 1,
      skipped: blankSkipped,
      issues: [
        {
          row: 0,
          message: M.ANNEXURE_TOO_MANY_ROWS(SI_ANNEXURE_MAX_ROWS),
        },
      ],
    };
  }

  if (issues.length > 0) {
    return {
      imported: 0,
      failed: issues.length,
      skipped: blankSkipped,
      issues,
    };
  }

  if (candidateLines.length === 0) {
    return {
      imported: 0,
      failed: 1,
      skipped: blankSkipped,
      issues: [{ row: 0, message: M.ANNEXURE_EMPTY }],
    };
  }

  return {
    imported: candidateLines.length,
    failed: 0,
    skipped: blankSkipped,
    issues: [],
    lines: candidateLines,
    totals: aggregateAnnexureTotals(candidateLines),
  };
}

/**
 * Legacy tax-invoice annexures: map into the shared line shape for preview/totals.
 * Amount is taken as written (Rate × qty is often not meaningful for these sheets).
 */
function parseTaxInvoiceStyleMatrix(
  matrix: unknown[][],
): ServiceInvoiceAnnexureParseResult {
  const headerRow = matrix[0] ?? [];
  const qtyHeader =
    findHeaderIndex(headerRow, "Lifted Qty.") >= 0
      ? "Lifted Qty."
      : findHeaderIndex(headerRow, "Lifted Qty") >= 0
        ? "Lifted Qty"
        : "Billed Quantity";

  const required = [
    "Tax Invoice No.",
    "Date",
    "Sold to Party Name",
    "Material Description",
    "Rate",
    qtyHeader,
    "Amount",
  ] as const;

  const { columnIndexByKey, missingLabels } = buildHeaderIndexMap(
    headerRow,
    required,
  );
  if (missingLabels.length > 0) {
    return {
      imported: 0,
      failed: 1,
      skipped: 0,
      issues: [
        {
          row: 1,
          message: M.ANNEXURE_HEADER_MISSING(missingLabels.join(", ")),
        },
      ],
    };
  }

  const nosIdx = findHeaderIndex(headerRow, "NOS");
  const netWeightIdx = findHeaderIndex(headerRow, "Net Weight (Kgs)");
  if (nosIdx >= 0) columnIndexByKey.set("NOS", nosIdx);
  if (netWeightIdx >= 0) {
    columnIndexByKey.set("Net Weight (Kgs)", netWeightIdx);
  }

  const issues: ServiceInvoiceAnnexureParseIssue[] = [];
  const candidateLines: ServiceInvoiceAnnexureLine[] = [];
  let blankSkipped = 0;

  for (let i = 1; i < matrix.length; i++) {
    const cols = matrix[i] ?? [];
    if (isImportRowBlank(cols)) {
      blankSkipped += 1;
      continue;
    }

    const excelRow = i + 1;
    const invoiceNo = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "Tax Invoice No."),
    );
    const dateRaw = cellByHeaderKey(cols, columnIndexByKey, "Date");
    const bidderName = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "Sold to Party Name"),
    );
    const product = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "Material Description"),
    );
    const nos = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "NOS"),
    );
    const approvedQty = castImportNumber(
      cellByHeaderKey(cols, columnIndexByKey, "Net Weight (Kgs)"),
    );
    const winningPrice = castImportNumber(
      cellByHeaderKey(cols, columnIndexByKey, "Rate"),
    );
    const liftedQty = castImportNumber(
      cellByHeaderKey(cols, columnIndexByKey, qtyHeader),
    );
    const amount = castImportNumber(
      cellByHeaderKey(cols, columnIndexByKey, "Amount"),
    );

    // Legacy tax-invoice sheets often end with a totals/footer row — skip
    // incomplete rows instead of failing the whole workbook (all-or-nothing
    // is reserved for the strict auction template path).
    const dateResult = castAnnexureDateToIso(dateRaw);
    if (
      !invoiceNo ||
      !dateResult.ok ||
      !dateResult.iso ||
      winningPrice == null ||
      winningPrice < 0 ||
      liftedQty == null ||
      liftedQty < 0 ||
      amount == null ||
      amount < 0
    ) {
      blankSkipped += 1;
      continue;
    }

    candidateLines.push({
      lineOrder: candidateLines.length + 1,
      auctionNumber: invoiceNo,
      auctionDate: dateResult.iso,
      lotNumber: nos || String(excelRow - 1),
      product,
      approvedQty: approvedQty ?? 0,
      uom: netWeightIdx >= 0 ? "Kgs" : "",
      rankLabel: "",
      winningPrice,
      bidderName,
      liftedQty,
      amount: round3(amount),
    });
  }

  return finishParse({ candidateLines, issues, blankSkipped });
}

function parseAuctionStyleMatrix(
  matrix: unknown[][],
): ServiceInvoiceAnnexureParseResult {
  const headerRow = aliasHeaderRow(matrix[0] ?? []);
  const { columnIndexByKey, missingLabels } = buildHeaderIndexMap(
    headerRow,
    SI_ANNEXURE_FIXED_REQUIRED_HEADERS,
  );

  if (missingLabels.length > 0) {
    return {
      imported: 0,
      failed: 1,
      skipped: 0,
      issues: [
        {
          row: 1,
          message: M.ANNEXURE_HEADER_MISSING(missingLabels.join(", ")),
        },
      ],
    };
  }

  const rankColumns = resolveRankColumns(headerRow);
  if (!rankColumns.ok) {
    return {
      imported: 0,
      failed: 1,
      skipped: 0,
      issues: [{ row: 1, message: rankColumns.message }],
    };
  }

  const { priceKey, bidderKey } = rankColumns;
  columnIndexByKey.set(priceKey, findHeaderIndex(headerRow, priceKey));
  columnIndexByKey.set(bidderKey, findHeaderIndex(headerRow, bidderKey));

  const issues: ServiceInvoiceAnnexureParseIssue[] = [];
  const candidateLines: ServiceInvoiceAnnexureLine[] = [];
  let blankSkipped = 0;

  for (let i = 1; i < matrix.length; i++) {
    const cols = matrix[i] ?? [];
    if (isImportRowBlank(cols)) {
      blankSkipped += 1;
      continue;
    }

    const excelRow = i + 1;
    const auctionNumber = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "Auction No."),
    );
    const auctionDateRaw = cellByHeaderKey(
      cols,
      columnIndexByKey,
      "Auction Date",
    );
    const lotNumber = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "Lot No."),
    );
    const product = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "Product"),
    );
    const approvedQty = castImportNumber(
      cellByHeaderKey(cols, columnIndexByKey, "Approved Qty."),
    );
    const uom = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, "Unit"),
    );
    const winningPrice = castImportNumber(
      cellByHeaderKey(cols, columnIndexByKey, priceKey),
    );
    const bidderName = coerceImportCellString(
      cellByHeaderKey(cols, columnIndexByKey, bidderKey),
    );
    const liftedQty = castImportNumber(
      cellByHeaderKey(cols, columnIndexByKey, "Lifted Qty."),
    );
    const amount = castImportNumber(
      cellByHeaderKey(cols, columnIndexByKey, "Amount"),
    );

    const dateResult = castAnnexureDateToIso(auctionDateRaw);
    if (!dateResult.ok) {
      issues.push({
        row: excelRow,
        field: "Auction Date",
        message: dateResult.error,
      });
    }
    if (!auctionNumber) {
      issues.push({
        row: excelRow,
        field: "Auction No.",
        message: M.ANNEXURE_ROW_INVALID,
      });
    }
    if (!lotNumber) {
      issues.push({
        row: excelRow,
        field: "Lot No.",
        message: M.ANNEXURE_ROW_INVALID,
      });
    }
    if (approvedQty == null || approvedQty < 0) {
      issues.push({
        row: excelRow,
        field: "Approved Qty.",
        message: M.TOTAL_QUANTITY_INVALID,
      });
    }
    if (winningPrice == null || winningPrice < 0) {
      issues.push({
        row: excelRow,
        field: priceKey,
        message: M.ANNEXURE_ROW_INVALID,
      });
    }
    if (liftedQty == null || liftedQty < 0) {
      issues.push({
        row: excelRow,
        field: "Lifted Qty.",
        message: M.TOTAL_QUANTITY_INVALID,
      });
    }
    if (amount == null || amount < 0) {
      issues.push({
        row: excelRow,
        field: "Amount",
        message: M.ANNEXURE_ROW_INVALID,
      });
    }

    if (
      winningPrice != null &&
      liftedQty != null &&
      amount != null &&
      Math.abs(amount - winningPrice * liftedQty) > SI_ANNEXURE_AMOUNT_TOLERANCE
    ) {
      issues.push({
        row: excelRow,
        field: "Amount",
        message: M.ANNEXURE_AMOUNT_MISMATCH,
      });
    }

    if (issues.some((iss) => iss.row === excelRow)) {
      continue;
    }

    const computedAmount = round3((winningPrice ?? 0) * (liftedQty ?? 0));
    candidateLines.push({
      lineOrder: candidateLines.length + 1,
      auctionNumber,
      auctionDate: dateResult.ok ? dateResult.iso : "",
      lotNumber,
      product,
      approvedQty: approvedQty ?? 0,
      uom,
      rankLabel: WINNER_LABEL,
      winningPrice: winningPrice ?? 0,
      bidderName,
      liftedQty: liftedQty ?? 0,
      amount: computedAmount,
    });
  }

  return finishParse({ candidateLines, issues, blankSkipped });
}

/**
 * All-or-nothing annexure parse. Any header/row failure → imported: 0, no lines.
 * Accepts current template headers and legacy AuctionIT5.0 labels / tax-invoice sheets.
 */
export async function parseServiceInvoiceAnnexureBuffer(
  buffer: Buffer,
): Promise<ServiceInvoiceAnnexureParseResult> {
  const { matrix } = await readXlsxMatrix(buffer, {
    preferredSheetNames: [SI_ANNEXURE_SHEET],
  });

  if (matrix.length === 0) {
    return {
      imported: 0,
      failed: 1,
      skipped: 0,
      issues: [{ row: 0, message: M.ANNEXURE_SPREADSHEET_EMPTY }],
    };
  }

  const rawHeader = matrix[0] ?? [];
  if (isTaxInvoiceStyleHeader(rawHeader)) {
    return parseTaxInvoiceStyleMatrix(matrix);
  }

  return parseAuctionStyleMatrix(matrix);
}

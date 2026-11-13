import {
  LIFTING_CLIENTS_REMARKS_MAX_LENGTH,
  LiftingClientsValidationMessages,
} from "@auctionit/messages/lifting-clients";

export type CastImportQtyResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export type CastImportRemarksResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Neutral cell → trimmed string for spreadsheet imports. */
export function coerceImportCellString(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return "";
    const rounded = Math.round(val);
    if (Math.abs(val - rounded) < 1e-9) {
      return String(rounded);
    }
    return String(val);
  }
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "object" && val !== null && "text" in val) {
    const text = (val as { text?: unknown }).text;
    return typeof text === "string" ? text.trim() : "";
  }
  return String(val).trim();
}

/** Parse a numeric cell; returns null when empty or non-numeric. */
export function castImportNumber(value: unknown): number | null {
  const text = coerceImportCellString(value).replace(/,/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise y/yes/true/1 → true, n/no/false/0 → false, else null (invalid).
 */
export function parseYesNo(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "y" || v === "yes" || v === "true" || v === "1") return true;
  if (v === "n" || v === "no" || v === "false" || v === "0") return false;
  return null;
}

export function roundImportQty(value: number): number {
  return Math.round(value * 100) / 100;
}

/** True when the lifted-qty cell has a value worth validating (non-empty). */
export function isLiftedQtyProvided(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (typeof value === "number") return Number.isFinite(value);
  return coerceImportCellString(value).replace(/,/g, "").length > 0;
}

/** Parses lifted quantity from Excel cells; rejects negative/non-numeric. */
export function castImportQtyToNumber(value: unknown): CastImportQtyResult {
  if (value == null || value === "") {
    return {
      ok: false,
      error: LiftingClientsValidationMessages.LIFTED_QTY_REQUIRED,
    };
  }

  let numeric: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return {
        ok: false,
        error: LiftingClientsValidationMessages.LIFTED_QTY_NOT_NUMBER,
      };
    }
    numeric = value;
  } else {
    const text = coerceImportCellString(value).replace(/,/g, "");
    if (!text) {
      return {
        ok: false,
        error: LiftingClientsValidationMessages.LIFTED_QTY_REQUIRED,
      };
    }
    numeric = Number(text);
    if (!Number.isFinite(numeric)) {
      return {
        ok: false,
        error: LiftingClientsValidationMessages.LIFTED_QTY_NOT_NUMBER,
      };
    }
  }

  const rounded = roundImportQty(numeric);
  if (rounded < 0) {
    return {
      ok: false,
      error: LiftingClientsValidationMessages.LIFTED_QTY_CANNOT_BE_NEGATIVE,
    };
  }

  return { ok: true, value: rounded };
}

/** Trims remarks and enforces max length (empty allowed). */
export function castImportRemarks(value: unknown): CastImportRemarksResult {
  const text = coerceImportCellString(value);
  if (text.length > LIFTING_CLIENTS_REMARKS_MAX_LENGTH) {
    return {
      ok: false,
      error: LiftingClientsValidationMessages.REMARKS_MAX(
        LIFTING_CLIENTS_REMARKS_MAX_LENGTH,
      ),
    };
  }
  return { ok: true, value: text };
}

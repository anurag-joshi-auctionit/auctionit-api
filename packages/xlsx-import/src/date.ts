import { parseTimeOfDayString } from "@auctionit/lib/time-of-day";
import { LiftingClientsValidationMessages } from "@auctionit/messages/lifting-clients";
import { coerceImportCellString } from "./coerce.js";

export type CastImportDateResult =
  | { ok: true; iso: string }
  | { ok: false; error: string };

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toIsoDate(y: number, month: number, day: number): string {
  return `${y}-${pad2(month)}-${pad2(day)}`;
}

function isValidCalendarDate(y: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(y, month - 1, day);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === month - 1 &&
    dt.getDate() === day
  );
}

function normalizeYear(y: number): number {
  if (y >= 100) return y;
  return y >= 70 ? 1900 + y : 2000 + y;
}

function formatLocalDate(d: Date): string {
  return toIsoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Excel 1900-date-system serial → ISO calendar date (timezone-neutral). */
export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const wholeDays = Math.round(serial);
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + wholeDays * 86_400_000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (!isValidCalendarDate(y, month, day)) return null;
  return toIsoDate(y, month, day);
}

/** Excel serial (with optional fraction) → ISO datetime string (UTC). */
export function excelSerialToIsoDateTime(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + serial * 86_400_000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseSlashSeparatedDate(raw: string): CastImportDateResult {
  const match = SLASH_DATE_RE.exec(raw.trim());
  if (!match) {
    return {
      ok: false,
      error: LiftingClientsValidationMessages.DATE_UNRECOGNIZED_FORMAT,
    };
  }

  const partA = Number(match[1]);
  const partB = Number(match[2]);
  const year = normalizeYear(Number(match[3]));

  let month: number;
  let day: number;

  if (partA > 12 && partB <= 12) {
    day = partA;
    month = partB;
  } else if (partB > 12 && partA <= 12) {
    month = partA;
    day = partB;
  } else if (partA <= 12 && partB <= 12) {
    return {
      ok: false,
      error: LiftingClientsValidationMessages.DATE_AMBIGUOUS,
    };
  } else {
    return { ok: false, error: LiftingClientsValidationMessages.DATE_INVALID };
  }

  if (!isValidCalendarDate(year, month, day)) {
    return { ok: false, error: LiftingClientsValidationMessages.DATE_INVALID };
  }

  return { ok: true, iso: toIsoDate(year, month, day) };
}

/**
 * Converts Excel / spreadsheet date cell values to ISO `YYYY-MM-DD`.
 */
export function castImportDateToIso(value: unknown): CastImportDateResult {
  if (value == null || value === "") {
    return { ok: true, iso: "" };
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { ok: false, error: LiftingClientsValidationMessages.DATE_INVALID };
    }
    return { ok: true, iso: formatLocalDate(value) };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const iso = excelSerialToIsoDate(value);
    if (!iso) {
      return {
        ok: false,
        error: LiftingClientsValidationMessages.DATE_INVALID_EXCEL_SERIAL,
      };
    }
    return { ok: true, iso };
  }

  const text = String(value).trim();
  if (!text) return { ok: true, iso: "" };

  const isoMatch = ISO_DATE_RE.exec(text);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (!isValidCalendarDate(y, month, day)) {
      return { ok: false, error: LiftingClientsValidationMessages.DATE_INVALID };
    }
    return { ok: true, iso: toIsoDate(y, month, day) };
  }

  return parseSlashSeparatedDate(text);
}

export function isIsoDateString(value: string): boolean {
  return castImportDateToIso(value).ok && ISO_DATE_RE.test(value);
}

/**
 * Cast import time-of-day: `HH:mm[:ss]`, 12h AM/PM (defensive), Date, Excel serial, or datetime → `HH:mm:ss`.
 * Same function is used for lotStartTime and lotEndTime — no per-field asymmetry.
 */
export function castImportTimeOfDay(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return `${pad2(raw.getHours())}:${pad2(raw.getMinutes())}:${pad2(raw.getSeconds())}`;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const fraction = raw % 1;
    const totalSeconds = Math.round(fraction * 86_400);
    const h = Math.floor(totalSeconds / 3600) % 24;
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }
  const text = coerceImportCellString(raw);
  if (!text) return null;

  const fromClock = parseTimeOfDayString(text);
  if (fromClock) return fromClock;

  if (/^\d+(\.\d+)?$/.test(text)) {
    return castImportTimeOfDay(Number(text));
  }

  const iso = castImportDateTimeToIso(text);
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * Cast import datetime: ISO strings, Date, or Excel serial.
 */
export function castImportDateTimeToIso(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return excelSerialToIsoDateTime(raw);
  }
  const text = coerceImportCellString(raw);
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    return excelSerialToIsoDateTime(Number(text));
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  const m = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${pad2(Number(m[4]))}:${m[5]}:${pad2(Number(m[6] ?? 0))}.000Z`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

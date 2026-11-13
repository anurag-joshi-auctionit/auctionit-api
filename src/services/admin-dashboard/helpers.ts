export function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalize pg date/timestamp/text to YYYY-MM-DD for bucket labels. */
export function toPeriodIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value ?? "");
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? s.slice(0, 10);
}

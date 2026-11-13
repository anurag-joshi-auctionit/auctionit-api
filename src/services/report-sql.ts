import { sql, type SQL } from "drizzle-orm";

/** Inclusive `YYYY-MM-DD` range. */
export type ReportDateRange = { from: string; to: string };

/** Lots counted in Revenue / Lifting reports; expects aliases `a` (auctions) and `l` (auction_lots). */
export const LOT_SCOPE = sql`a.is_active = true AND l.is_active = true AND a.status = 'closed'`;
export const AUCTION_DAY = sql`(a.auction_date AT TIME ZONE 'Asia/Kolkata')::date`;

export function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function dateParams(params: ReportDateRange): { from: SQL; to: SQL } {
  return {
    from: sql`CAST(${params.from} AS date)`,
    to: sql`CAST(${params.to} AS date)`,
  };
}

import { sql, type SQL } from "drizzle-orm";

/** Round a quantity to two decimal places (API responses and writes). */
export function roundQtyToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Parse a DB/string value as a quantity, defaulting to 0 and rounding to 2 decimals. */
export function parseQty(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return roundQtyToTwoDecimals(Number.isFinite(n) ? n : 0);
}

/** Like {@link parseQty} but preserves null for optional quantity fields. */
export function parseQtyOrNull(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? roundQtyToTwoDecimals(n) : null;
}

export function computeBalanceQty(
  approvedQty: number,
  liftedQtyBidder: number,
  liftedQtyClient: number,
): number {
  const raw = Math.max(
    0,
    approvedQty - Math.max(liftedQtyBidder, liftedQtyClient),
  );
  return roundQtyToTwoDecimals(raw);
}

/** Wrap a numeric SQL expression with `ROUND(..., 2)` for list sort / computed columns. */
export function roundQtySql(expr: SQL): SQL {
  return sql`ROUND(CAST((${expr}) AS decimal(38, 3)), 2)`;
}

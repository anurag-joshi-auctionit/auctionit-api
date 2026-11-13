/**
 * Weight / per-tonne UOM codes whose quantities are summable for dashboard KPIs.
 * Matches live-monitor Offered/Sold totals (legacy Proc_GetLiveAuctionQTY).
 */
export const PMT_UOM_CODES = ["MT", "RSPMT", "AEDPMT"] as const;

/** SQL fragment: normalize uoms.code then match PMT-family codes. */
export const PMT_UOM_SQL = `upper(replace(u.code, ' ', '')) IN ('MT', 'RSPMT', 'AEDPMT')`;

export function isPmtUomCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const normalized = code.toUpperCase().replace(/\s+/g, "");
  return (PMT_UOM_CODES as readonly string[]).includes(normalized);
}

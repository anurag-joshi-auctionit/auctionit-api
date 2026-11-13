import { formatDate, formatDateTimeSeconds } from "@auctionit/lib/date";
import type { AuctionReportMeta } from "./auction-report-meta.js";

/** e.g. `Bid Overview Report [01 Sep 2026 to 28 Sep 2026]`. */
export function dateRangeReportTitle(
  name: string,
  from: string,
  to: string,
): string {
  return `${name} [${formatDate(from)} to ${formatDate(to)}]`;
}

/**
 * e.g. `Bid Details Report of ATIL/e-Sales/2025-26/01 - ATIL [21 Sep 2026]`.
 * Client is omitted when `includeClient` is false (client portal).
 */
export function auctionReportTitle(
  name: string,
  meta: AuctionReportMeta,
  options: { includeClient: boolean },
): string {
  let title = name;
  if (meta.auctionNumber) title += ` of ${meta.auctionNumber}`;
  if (options.includeClient && meta.clientName) {
    title += ` - ${meta.clientName}`;
  }
  const date = formatDate(meta.auctionDate);
  if (date) title += ` [${date}]`;
  return title;
}

/** Current Asia/Kolkata wall-clock, e.g. `28 Sep 2026, 11:57:12 am`. */
export function reportGeneratedAt(now: Date = new Date()): string {
  return formatDateTimeSeconds(now);
}

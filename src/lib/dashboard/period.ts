export type IsoDateRange = { from: string; to: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function parseIsoDateUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function toIsoDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addUtcDays(iso: string, days: number): string {
  const d = parseIsoDateUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDateUtc(d);
}

/** Inclusive day count between from and to (both ISO YYYY-MM-DD). */
export function inclusiveDaySpan(from: string, to: string): number {
  const a = parseIsoDateUtc(from).getTime();
  const b = parseIsoDateUtc(to).getTime();
  return Math.floor((b - a) / 86_400_000) + 1;
}

/**
 * Equal-length window immediately before `from`:
 * priorTo = from - 1 day; priorFrom covers the same inclusive day span.
 */
export function equalLengthPriorPeriod(range: IsoDateRange): IsoDateRange {
  if (!ISO_DATE_RE.test(range.from) || !ISO_DATE_RE.test(range.to)) {
    throw new Error("Invalid ISO date range");
  }
  if (range.from > range.to) {
    throw new Error("Invalid date order");
  }
  const span = inclusiveDaySpan(range.from, range.to);
  const priorTo = addUtcDays(range.from, -1);
  const priorFrom = addUtcDays(priorTo, -(span - 1));
  return { from: priorFrom, to: priorTo };
}

/** Display label: DD MMM YYYY (calendar date, no TZ shift). */
export function formatDashboardDateLabel(iso: string): string {
  if (!ISO_DATE_RE.test(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const day = String(d!).padStart(2, "0");
  return `${day} ${MONTHS[m! - 1]} ${y}`;
}

export function formatDashboardPeriodLabel(range: IsoDateRange): string {
  return `${formatDashboardDateLabel(range.from)} – ${formatDashboardDateLabel(range.to)}`;
}

export type MaterialSeriesGrain = "month" | "quarter" | "year";

export type DashboardGrain = "day" | "week" | "month" | "quarter" | "year";

/**
 * Inclusive calendar-month span between ISO dates (same month → 1).
 * Used to pick Material Details chart grain so long ranges stay readable.
 */
export function inclusiveMonthSpan(from: string, to: string): number {
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
    throw new Error("Invalid ISO date range");
  }
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!) + 1;
}

/**
 * ≤ 18 months → month; ≤ 36 months → quarter; longer → year.
 */
export function resolveMaterialSeriesGrain(
  range: IsoDateRange,
): MaterialSeriesGrain {
  const months = inclusiveMonthSpan(range.from, range.to);
  if (months <= 18) return "month";
  if (months <= 36) return "quarter";
  return "year";
}

/**
 * ≤ 45 days → day; ≤ 26 weeks → week; ≤ 18 months → month;
 * ≤ 36 months → quarter; longer → year.
 */
export function resolveDashboardGrain(range: IsoDateRange): DashboardGrain {
  const days = inclusiveDaySpan(range.from, range.to);
  if (days <= 45) return "day";
  if (days <= 26 * 7) return "week";
  const months = inclusiveMonthSpan(range.from, range.to);
  if (months <= 18) return "month";
  if (months <= 36) return "quarter";
  return "year";
}

/** Postgres date_trunc unit matching DashboardGrain. */
export function dashboardGrainToDateTrunc(grain: DashboardGrain): string {
  return grain;
}

/**
 * % change vs previous period.
 * both 0 → 0; previous 0 & current > 0 → 100; previous 0 & current < 0 → -100;
 * else ((current - previous) / |previous|) * 100.
 */
export function percentChange(current: number, previous: number): number {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return current > 0 ? 100 : -100;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export type MetricWithDelta = {
  value: number;
  previousValue: number;
  percentChange: number;
  previousPeriodLabel: string;
};

export function withDelta(
  value: number,
  previousValue: number,
  previousPeriodLabel: string,
): MetricWithDelta {
  return {
    value,
    previousValue,
    percentChange: percentChange(value, previousValue),
    previousPeriodLabel,
  };
}

/** Bucket label for a truncated period start (ISO date or timestamp string). */
export function formatDashboardBucketLabel(
  periodStart: string,
  grain: DashboardGrain,
): string {
  const iso = periodStart.slice(0, 10);
  if (!ISO_DATE_RE.test(iso)) return periodStart;
  const [y, m, d] = iso.split("-").map(Number);
  if (grain === "day") {
    return `${String(d!).padStart(2, "0")} ${MONTHS[m! - 1]}`;
  }
  if (grain === "week") {
    return `${String(d!).padStart(2, "0")} ${MONTHS[m! - 1]}`;
  }
  if (grain === "month") {
    return `${MONTHS[m! - 1]} ${y}`;
  }
  if (grain === "quarter") {
    const q = Math.ceil(m! / 3);
    return `Q${q} ${y}`;
  }
  return String(y);
}

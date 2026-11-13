/** Snap any ISO date to the first day of its month (MM-YYYY → YYYY-MM-01). */
export function normalizeToFirst(dateISO: string): string {
  return `${dateISO.slice(0, 7)}-01`;
}

/** Calendar month key `YYYY-MM` for comparisons. */
export function monthKey(dateISO: string): string {
  return dateISO.slice(0, 7);
}

function ym(iso: string): { y: number; m: number } {
  const [ys, ms] = iso.split("-");
  return { y: Number(ys), m: Number(ms) };
}

/**
 * End of the month `months - 1` after `fromISO` (legacy EOMONTH(DATEADD…)).
 * Annual (12): from 2026-07-01 → to 2027-06-30.
 */
export function endOfTermMonth(fromISO: string, months: number): string {
  const { y, m } = ym(fromISO);
  const idx0 = m - 1 + (months - 1);
  const year = y + Math.floor(idx0 / 12);
  const monthInYear0 = ((idx0 % 12) + 12) % 12;
  return new Date(Date.UTC(year, monthInYear0 + 1, 0)).toISOString().slice(0, 10);
}

/**
 * True when the subscription start month is on or after the payment month.
 * Compare calendar months only (day ignored).
 */
export function isFromMonthOnOrAfterPaymentMonth(
  fromISO: string,
  paymentDateISO: string,
): boolean {
  return monthKey(fromISO) >= monthKey(paymentDateISO);
}

/**
 * Validity period from an explicit start month through end of term for `months`.
 */
export function periodFromStartMonth(
  fromISO: string,
  months: number,
): { fromDate: string; toDate: string } {
  const fromDate = normalizeToFirst(fromISO);
  return { fromDate, toDate: endOfTermMonth(fromDate, months) };
}

/**
 * Validity period from payment date: first day of payment month through
 * end of term for `months` (plan duration). Used by portal online pay.
 */
export function periodFromPaymentDate(
  paymentDateISO: string,
  months: number,
): { fromDate: string; toDate: string } {
  return periodFromStartMonth(paymentDateISO, months);
}

/** First of current calendar month in Asia/Kolkata as YYYY-MM-01. */
export function firstOfCurrentMonthIST(now = new Date()): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(now);
  return normalizeToFirst(today);
}

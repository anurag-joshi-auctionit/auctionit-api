/**
 * Legacy OSB stored a window start (OnlineSealedBidPublishStartDate, IST
 * wall-clock, no offset) plus WindowOpeningDurationInHours. The new schema
 * stores the window as sealed_bid_date + sealed_bid_start_time / end_time.
 *
 * A window that crosses midnight cannot fit one calendar date — the end is
 * capped at 23:59:59 and `capped` is set so the caller can log the auction.
 */
export type SealedBidWindow = {
  sealedBidDate: string | null;
  sealedBidStartTime: string | null;
  sealedBidEndTime: string | null;
  capped: boolean;
};

const EMPTY: SealedBidWindow = {
  sealedBidDate: null,
  sealedBidStartTime: null,
  sealedBidEndTime: null,
  capped: false,
};

const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

const pad = (n: number) => String(n).padStart(2, "0");

export function legacySealedBidWindow(
  start: string | null | undefined,
  durationHours: string | number | null | undefined,
): SealedBidWindow {
  if (!start) return EMPTY;
  const m = WALL_CLOCK.exec(start.trim());
  if (!m) return EMPTY;
  const [, y, mo, d, h, mi, s] = m;
  const startSec = Number(h) * 3600 + Number(mi) * 60 + Number(s ?? 0);
  const window: SealedBidWindow = {
    sealedBidDate: `${y}-${mo}-${d}T00:00:00`,
    sealedBidStartTime: `${h}:${mi}:${s ?? "00"}`,
    sealedBidEndTime: null,
    capped: false,
  };

  const hours = durationHours == null ? NaN : Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0) return window;

  const endSec = startSec + Math.round(hours * 3600);
  const lastSec = 24 * 3600 - 1;
  if (startSec >= lastSec) return window;
  const capped = endSec > lastSec;
  const e = Math.min(endSec, lastSec);
  window.sealedBidEndTime = `${pad(Math.floor(e / 3600))}:${pad(Math.floor((e % 3600) / 60))}:${pad(e % 60)}`;
  window.capped = capped;
  return window;
}

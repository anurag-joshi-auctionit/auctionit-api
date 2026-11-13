import type {
  AuctionScheduleBucket,
  AuctionStatus,
} from "../../db/schema/auctions.js";

export type LotTimeInput = {
  lotStartTime: string | null;
  lotEndTime: string | null;
  /**
   * Effective end when the lot was extended (no-bid extension, last-bid
   * anti-sniping, or stagger). IST wall-clock timestamp string, matching
   * `auction_lots.extended_end_time`.
   */
  lotExtendedEndTime?: string | null;
};

/** @deprecated Prefer LotTimeInput; kept for call sites that only supply ends. */
export type LotEndTimeInput = {
  lotEndTime: string | null;
  lotStartTime?: string | null;
  lotExtendedEndTime?: string | null;
};

const PHASE1_STATUSES: AuctionStatus[] = ["draft", "archived"];
const PHASE2_STATUSES: AuctionStatus[] = ["published"];
const PHASE3_STATUSES: AuctionStatus[] = ["closed"];

/**
 * Lot start/end times are IST wall-clock, matching SQL
 * `(auction_date::date + start_time) AT TIME ZONE 'Asia/Kolkata'`.
 * India does not observe DST.
 */
export const AUCTION_SCHEDULE_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

type Ymd = { year: number; month: number; day: number };

export function isPhase1Status(status: AuctionStatus): boolean {
  return PHASE1_STATUSES.includes(status);
}

export function isPhase2Status(status: AuctionStatus): boolean {
  return PHASE2_STATUSES.includes(status);
}

export function isPhase3Status(status: AuctionStatus): boolean {
  return PHASE3_STATUSES.includes(status);
}

export type AdminAuctionPhase = "creation" | "execution" | "settlement";

export function deriveAdminPhase(status: AuctionStatus): AdminAuctionPhase {
  if (isPhase1Status(status)) return "creation";
  if (isPhase2Status(status)) return "execution";
  if (isPhase3Status(status)) return "settlement";
  return "creation";
}

function istYmd(instant: Date): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AUCTION_SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  return { year, month, day };
}

/** Instant for an Asia/Kolkata wall-clock date/time (same as PG `AT TIME ZONE`). */
export function fromIstWallClock(
  year: number,
  monthIndex0: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  return new Date(
    Date.UTC(year, monthIndex0, day, hour, minute, second, ms) - IST_OFFSET_MS,
  );
}

function endOfIstDay(instant: Date): Date {
  const { year, month, day } = istYmd(instant);
  return fromIstWallClock(year, month - 1, day, 23, 59, 59, 999);
}

function isSameIstDay(a: Date, b: Date): boolean {
  const left = istYmd(a);
  const right = istYmd(b);
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day
  );
}

export function parseAuctionDate(auctionDate: string): Date {
  return new Date(auctionDate);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * IST calendar day of `instant` as UTC-midnight `auction_date` encoding
 * (`YYYY-MM-DDT00:00:00.000Z`), matching create/publish and Live Monitor.
 */
export function auctionDateIsoForInstant(instant: Date = new Date()): string {
  const { year, month, day } = istYmd(instant);
  return `${year}-${pad2(month)}-${pad2(day)}T00:00:00.000Z`;
}

function auctionCalendarYmd(auctionDate: string): Ymd | null {
  const d = parseAuctionDate(auctionDate);
  if (Number.isNaN(d.getTime())) return null;
  // New encoding: UTC midnight of the chosen calendar day.
  if (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  ) {
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    };
  }
  // Legacy local-midnight (UTC-shifted) values: resolve via IST calendar day.
  return istYmd(d);
}

/**
 * Instant at 00:00 Asia/Kolkata on the auction calendar day.
 * New encoding stores auction dates as UTC midnight of the chosen day; legacy
 * values used local midnight (UTC-shifted). Both resolve to the intended day.
 */
export function auctionCalendarDay(auctionDate: string): Date {
  const ymd = auctionCalendarYmd(auctionDate);
  if (!ymd) return parseAuctionDate(auctionDate);
  return fromIstWallClock(ymd.year, ymd.month - 1, ymd.day, 0, 0, 0);
}

/** True when the auction's calendar day is today in Asia/Kolkata. */
export function isAuctionDateToday(
  auctionDate: string,
  now: Date = new Date(),
): boolean {
  const auctionYmd = auctionCalendarYmd(auctionDate);
  if (!auctionYmd) return false;
  const nowYmd = istYmd(now);
  return (
    auctionYmd.year === nowYmd.year &&
    auctionYmd.month === nowYmd.month &&
    auctionYmd.day === nowYmd.day
  );
}

const TIME_ONLY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
/** Naive timestamp stored as IST wall-clock (matches PG `AT TIME ZONE 'Asia/Kolkata'`). */
const IST_WALL_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * Combine auction calendar date with a lot time (`HH:mm[:ss]` or full ISO).
 * Time-of-day values are Asia/Kolkata wall-clock (not the process timezone).
 */
export function parseLotDateTime(
  lotTime: string,
  auctionDate?: string | null,
): Date | null {
  const trimmed = lotTime.trim();
  if (!trimmed) return null;

  const timeOnly = TIME_ONLY_RE.exec(trimmed);
  if (timeOnly) {
    if (!auctionDate) return null;
    const ymd = auctionCalendarYmd(auctionDate);
    if (!ymd) return null;
    return fromIstWallClock(
      ymd.year,
      ymd.month - 1,
      ymd.day,
      Number(timeOnly[1]),
      Number(timeOnly[2]),
      Number(timeOnly[3] ?? 0),
      0,
    );
  }

  const full = new Date(trimmed);
  return Number.isNaN(full.getTime()) ? null : full;
}

/**
 * Parse a timezone-naive timestamp as Asia/Kolkata wall-clock (same as
 * `timestamp AT TIME ZONE 'Asia/Kolkata'` in Postgres).
 * Rejects strings with an explicit offset / Z.
 */
export function parseIstWallTimestamp(raw: string): Date | null {
  const m = IST_WALL_TIMESTAMP_RE.exec(raw.trim());
  if (!m) return null;
  return fromIstWallClock(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
    0,
  );
}

function parseLotTimes(
  lots: Array<LotEndTimeInput | LotTimeInput>,
  field: "lotStartTime" | "lotEndTime",
  auctionDate?: string | null,
): Date[] {
  return lots
    .map((l) => {
      const raw = field === "lotStartTime" ? l.lotStartTime : l.lotEndTime;
      return raw;
    })
    .filter((t): t is string => t != null && t.trim() !== "")
    .map((t) => parseLotDateTime(t, auctionDate))
    .filter((d): d is Date => d != null);
}

/** Effective lot end: extended_end_time when set, otherwise scheduled end_time. */
export function effectiveLotEnd(
  lot: LotEndTimeInput | LotTimeInput,
  auctionDate?: string | null,
): Date | null {
  const extended = lot.lotExtendedEndTime?.trim();
  if (extended) {
    return parseIstWallTimestamp(extended) ?? parseLotDateTime(extended, auctionDate);
  }
  const scheduled = lot.lotEndTime;
  if (scheduled == null || scheduled.trim() === "") return null;
  return parseLotDateTime(scheduled, auctionDate);
}

/**
 * Earliest lot start, combined with auction calendar day.
 * Falls back to auction_date midnight when there are no parseable starts —
 * schedule/live/edit gates must not use that fallback alone (see
 * `hasEarliestLotStartPassed` / `deriveScheduleBucket`).
 */
export function earliestLotStart(
  lots: Array<LotEndTimeInput | LotTimeInput>,
  auctionDate: string,
): Date {
  const starts = parseLotTimes(lots, "lotStartTime", auctionDate);
  if (starts.length === 0) return auctionCalendarDay(auctionDate);
  return starts.reduce((min, d) => (d < min ? d : min), starts[0]!);
}

export function hasActiveLotStarts(
  lots: Array<LotEndTimeInput | LotTimeInput>,
  auctionDate: string,
): boolean {
  return parseLotTimes(lots, "lotStartTime", auctionDate).length > 0;
}

/**
 * True when current time is after the earliest active lot start.
 * With no active lot starts, nothing has started — stays pre-live / editable.
 */
export function hasEarliestLotStartPassed(
  lots: Array<LotEndTimeInput | LotTimeInput>,
  auctionDate: string,
  now: Date = new Date(),
): boolean {
  if (!hasActiveLotStarts(lots, auctionDate)) return false;
  return now > earliestLotStart(lots, auctionDate);
}

/**
 * Latest effective lot end (includes no-bid / last-bid / stagger extensions).
 * Null when no valid ends.
 */
export function latestLotEnd(
  lots: Array<LotEndTimeInput | LotTimeInput>,
  auctionDate?: string | null,
): Date | null {
  const ends = lots
    .map((l) => effectiveLotEnd(l, auctionDate))
    .filter((d): d is Date => d != null);
  if (ends.length === 0) return null;
  return ends.reduce((max, d) => (d > max ? d : max), ends[0]!);
}

export function isAllLotsEnded(
  lots: Array<LotEndTimeInput | LotTimeInput>,
  now: Date = new Date(),
  auctionDate?: string | null,
): boolean {
  const lastEnd = latestLotEnd(lots, auctionDate);
  if (!lastEnd) return false;
  return now > lastEnd;
}

/**
 * True when the auction schedule is over: after the latest lot end, or
 * (when no end times) after the end of the auction calendar day.
 */
export function isAuctionScheduleEnded(
  lots: Array<LotEndTimeInput | LotTimeInput>,
  now: Date = new Date(),
  auctionDate?: string | null,
): boolean {
  const lastEnd = latestLotEnd(lots, auctionDate);
  if (lastEnd) return now > lastEnd;
  if (!auctionDate) return false;
  const day = auctionCalendarDay(auctionDate);
  if (Number.isNaN(day.getTime())) return false;
  return now > endOfIstDay(day);
}

/** Derive live / upcoming / future from lot schedule (not a DB status).
 * Live is only for today's auction date (started, schedule not over).
 * Schedule end uses effective lot ends (extended_end_time when set — no-bid,
 * last-bid anti-sniping, stagger), matching Live Monitor.
 * Past published auctions keep status published but get no schedule bucket.
 */
export function deriveScheduleBucket(
  auctionDate: string,
  lots: Array<LotEndTimeInput | LotTimeInput> = [],
  now: Date = new Date(),
): AuctionScheduleBucket | null {
  // No active lot schedule → not future/upcoming/live (cannot invent live from
  // auction-day midnight when lots were deleted after publish).
  if (!hasActiveLotStarts(lots, auctionDate)) return null;
  const auctionStart = earliestLotStart(lots, auctionDate);
  if (auctionStart > endOfIstDay(now)) return "future";
  if (!isSameIstDay(auctionStart, now)) return null;
  if (now < auctionStart) return "upcoming";
  if (isAuctionScheduleEnded(lots, now, auctionDate)) return null;
  return "live";
}

export function statusFlags(status: AuctionStatus, isApproved = false) {
  return {
    isPublished: status !== "draft" && status !== "archived",
    isClosed: status === "closed",
    isApproved,
    isArchived: status === "archived",
    isCanceled: false,
  };
}

export type AuctionScheduleGateInput = {
  status: AuctionStatus;
  auctionDate: string;
  lots?: Array<LotEndTimeInput | LotTimeInput>;
  /** Sealed-bid window start, when the auction has one — it opens before any lot. */
  sealedBidStartAt?: Date | null;
  /** Sealed-bid window end; with the start it tells open from closed. */
  sealedBidEndAt?: Date | null;
  now?: Date;
};

/**
 * True once bidding has begun: the sealed-bid window has opened or the
 * earliest active lot start has passed.
 */
function hasAuctionStarted(input: AuctionScheduleGateInput): boolean {
  const now = input.now ?? new Date();
  if (input.sealedBidStartAt && now >= input.sealedBidStartAt) return true;
  return hasEarliestLotStartPassed(input.lots ?? [], input.auctionDate, now);
}

/**
 * Settings / lots are editable in draft always. A published auction is
 * editable until the first lot starts, except while the sealed-bid window is
 * open (only the sealed-bid settings can change then, directly on this
 * screen). The window closes and the auction becomes editable again.
 */
export function canEditAuctionContent(input: AuctionScheduleGateInput): boolean {
  if (input.status === "draft") return true;
  if (input.status !== "published") return false;
  const now = input.now ?? new Date();
  if (input.sealedBidStartAt && now >= input.sealedBidStartAt) {
    if (!input.sealedBidEndAt || now < input.sealedBidEndAt) return false;
  }
  return !hasEarliestLotStartPassed(input.lots ?? [], input.auctionDate, now);
}

/**
 * Sealed-bid fields are editable any time the auction is draft or published —
 * open, upcoming or already closed. Rescheduling the window forward (even
 * while it's live) is allowed; any sealed bids already placed are
 * soft-deleted as part of that save (see auctions.service `update`).
 */
export function canEditSealedBidWindow(input: AuctionScheduleGateInput): boolean {
  return input.status === "draft" || input.status === "published";
}

/** True while a sealed-bid window exists and `now` is inside it. */
export function isSealedBidWindowOpen(input: AuctionScheduleGateInput): boolean {
  const now = input.now ?? new Date();
  return (
    !!input.sealedBidStartAt &&
    !!input.sealedBidEndAt &&
    now >= input.sealedBidStartAt &&
    now < input.sealedBidEndAt
  );
}

/** @deprecated Prefer canEditAuctionContent (schedule-aware). */
export function canPatchAuctionSettings(status: AuctionStatus): boolean {
  return status === "draft";
}

/**
 * Lot settings are editable any time before the auction closes. Once closed,
 * only a lot an admin has explicitly reopened (`auction_lots.isReopened`)
 * stays editable.
 */
export function canEditLotContent(
  status: AuctionStatus,
  isReopened = false,
): boolean {
  return status !== "closed" || isReopened;
}

/** EMD config and Attach Bidders are editable only while the auction is published. */
export function canEditExecutionContent(status: AuctionStatus): boolean {
  return status === "published";
}

/**
 * Blanket gate for the auction-settings fields that otherwise have no
 * status-aware check (auction number/type, published-at, no-bid extension
 * rules, rank-based, IP restriction, start-bid-plus-increment). Editable any
 * time before the auction closes.
 */
export function canEditAuctionSettingsFields(status: AuctionStatus): boolean {
  return status !== "closed";
}

export function canApproveLots(status: AuctionStatus): boolean {
  return status === "closed";
}

export function canRejectLots(status: AuctionStatus): boolean {
  return status === "closed";
}

/**
 * Draft always; published only while bidding has not started.
 */
export function canArchiveAuction(input: AuctionScheduleGateInput): boolean {
  if (input.status === "draft") return true;
  if (input.status === "published") return !hasAuctionStarted(input);
  return false;
}

/**
 * Explicit "Move to Draft". Published only, and only while bidding has not
 * started — once the sealed window has opened a draft could never be
 * republished (the window start must be in the future).
 */
export function canUnpublishAuction(input: AuctionScheduleGateInput): boolean {
  if (input.status !== "published") return false;
  return !hasAuctionStarted(input);
}

export function canRestoreAuction(status: AuctionStatus): boolean {
  return status === "archived";
}

export type NoBidLotStatusInput = {
  noBidExtensionCountMax: number | null;
  noBidExtensionCount: number;
  /** Per-lot no-bid extension flag (auction_lots.is_no_bid_extension). */
  isNoBidExtension: boolean;
  /** auction_lots.is_reopened — reopened lots never extend. */
  isReopened?: boolean;
};

/**
 * Extension status for a no-bid lot. Stopped when the lot was reopened, the
 * lot's no-bid extension flag is off, the auction max count is 0 (or null), or
 * the running counter has reached the max count.
 */
export function deriveNoBidLotStatus(
  input: NoBidLotStatusInput,
): "Active" | "Stopped" {
  const maxCount = input.noBidExtensionCountMax ?? 0;
  const noExtend = maxCount <= 0;
  const exhausted = maxCount > 0 && input.noBidExtensionCount >= maxCount;
  return input.isReopened === true ||
    !input.isNoBidExtension ||
    noExtend ||
    exhausted
    ? "Stopped"
    : "Active";
}

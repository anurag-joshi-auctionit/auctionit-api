import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../db/index.js";
import { bidDirectionFor } from "@auctionit/lib/live-bid-bounds";
import { loadRankings, withBidderRanks } from "../lib/auctions/rank.js";
import { clearLotExtensionState } from "../lib/auctions/clear-lot-extension-state.js";
import {
  auctionLotBidderMaps,
  auctionLots,
  auctions,
  auctionSealedBids,
  bidders,
  clients,
} from "../db/schema/index.js";
import {
  AUCTION_SCHEDULE_BUCKETS,
  AUCTION_STATUSES,
  type AuctionScheduleBucket,
  type AuctionStatus,
} from "../db/schema/auctions.js";
import {
  AuctionsErrorMessages,
  AuctionsValidationMessages,
} from "@auctionit/messages/auctions";
import { formatUtcNow } from "@auctionit/lib/date";
import {
  sealedBidWindow,
  sealedBidWindowState,
} from "@auctionit/lib/auction-modes";
import { bidLimitVsStartPriceError } from "@auctionit/lib/bid-limit-vs-start";
import { bidIncrementVsPriceError } from "@auctionit/lib/bid-increment-vs-price";
import {
  collectLotWriteScheduleErrors,
  isPublishedAtAfterNow,
  isPublishedAtOnOrBeforeAuctionDate,
} from "@auctionit/lib/lot-schedule";
import { normalizeDisplayOrderKey } from "../lib/auction-lot-display-order.js";
import { buildAuctionNumber } from "../lib/auctions/auction-number.js";
import { emdBlocksService, emdLotsLabel } from "./emd-blocks.service.js";
import { emdTransactionsService } from "./emd-transactions.service.js";
import {
  computeWinningHoldTarget,
  currentWinningHoldTotal,
} from "./emd-winning-hold.service.js";
import { round2, toAmount } from "../lib/emd/constants.js";
import {
  buildAuctionListOrderBy,
  earliestLotStartSql,
  type AuctionsListSortBy,
} from "../lib/auctions/list-order.js";
import {
  MAX_SELECT_ALL_IDS,
  resolveOptionsLimit,
  toOptionIdsResult,
  type EntityOptionIdsResult,
} from "../lib/options-query.js";
import type {
  AuctionDocumentsListParams,
  PatchAuctionBody,
  LotCorrectionBody,
  ReopenLotsCorrectionBody,
  StaggerCorrectionBody,
} from "../lib/auctions/schemas.js";
import {
  auctionDateIsoForInstant,
  canApproveLots,
  canArchiveAuction,
  canUnpublishAuction,
  canEditSealedBidWindow,
  canEditAuctionContent,
  canEditAuctionSettingsFields,
  canEditLotContent,
  canEditExecutionContent,
  canRejectLots,
  canRestoreAuction,
  deriveNoBidLotStatus,
  deriveScheduleBucket,
  earliestLotStart,
  hasActiveLotStarts,
  hasEarliestLotStartPassed,
  isPhase2Status,
  isPhase3Status,
  statusFlags,
} from "../lib/auctions/status.js";
import {
  assertLotEmdDisplayOrdersInSync,
  computeBidderEmdRequired,
  computeBidderEmdRequiredFromEmdDisplayOrders,
  expandLotsFromEmdRanges,
  isLotDisplayOrderCoveredByRange,
  resolveEmdRangesByDisplayOrders,
  validateBlockRow,
} from "../lib/emd/emd-required.js";
import { EmdError } from "../lib/emd/errors.js";
import { unmappedSelectedLotIds } from "../lib/auctions/emd-range-validation.js";
import { parseLotBidderMapImportXlsxBuffer } from "../lib/parse-lot-bidder-map-import-buffer.js";
import { auctionAdditionalFieldsService } from "./auction-additional-fields.service.js";
import {
  dedupeLotBidderMapImportRows,
  parseIsEmdWithClient,
} from "../lib/lot-bidder-map-import/coerce.js";
import { normalizeLotBidderRemoveSelection } from "../lib/auctions/lot-bidder-map-remove.js";
import { blockedBidderIdsForClient } from "../lib/bidders/blocked-for-client.js";
import {
  pgAddBidderPoolEntries,
  pgAttachBidderToLots,
  pgActiveMappedLotFlags,
  pgActiveMappedLotsTx,
  pgActiveWalletLotIdsTx,
  pgHeldCoveredLotIds,
  pgReleasedMappedLotIds,
  pgBidderEmdWallets,
  pgActiveCatalogueAndTncUrls,
  pgActiveCatalogueDownloadUrl,
  pgActiveTncDownloadUrl,
  pgApplyLotCorrection,
  pgApproveLots,
  pgAuctionStats,
  pgBidderPool,
  pgBulkMapBidders,
  pgCreateLot,
  pgDeleteAllLots,
  pgDeleteEmdRange,
  pgDetachBiddersFromLots,
  pgEmdRanges,
  pgGetAuctionClientId,
  pgGetAuctionStatus,
  pgGetLot,
  pgIsLotClosed,
  pgInsertEmdRange,
  pgReplaceEmdRanges,
  pgAuctionHasBids,
  pgLotsWithAttachedBidders,
  pgListAuctionDocumentsPaginated,
  pgListAuctionDocumentTypes,
  pgListLotEditorOptions,
  pgListLots,
  pgListLotsPaginated,
  pgLoadWithdrawnDisplayOrderKeys,
  pgLotBidderMapForExport,
  pgLotBidderMapPaginated,
  pgLotBidderSummary,
  pgLotTimes,
  pgLotItems,
  pgReopenLots,
  pgApplyStaggerCorrection,
  pgSingleLotReopenBody,
  pgLotMappedBidders,
  pgCorrectionWinnerCandidates,
  pgNoBidLots,
  pgPatchLot,
  pgRejectLots,
  pgRemoveBidderPoolEntry,
  pgSaveLotApprovals,
  pgSetLotBidders,
  pgStopNoBidExtensionAll,
  pgStopNoBidExtensionLots,
  pgUploadAuctionDocument,
  pgCopyClientTncToAuction,
  pgWinnerName,
  pgWithdrawLot,
  type AuctionLotBidderMapListParams,
  type AuctionLotsListParams,
  type CreateLotBody,
  type SaveLotApprovalEntry,
} from "./auctions-pg.service.js";
import {
  AuctionNotFoundError,
  AuctionValidationError,
} from "./auctions-errors.js";
import {
  notifyLotConfirmationWinners,
  syncLotConfirmationPdf,
  winnerBidderIdsForLots,
} from "./lot-confirmation.service.js";

export {
  AuctionNotFoundError,
  AuctionValidationError,
} from "./auctions-errors.js";

/**
 * A lot (or lot-scoped row) is missing on an existing auction. Subclass of
 * AuctionNotFoundError so existing 404 handling still applies; the admin route
 * maps it to LOT_NOT_FOUND instead of AUCTION_NOT_FOUND.
 */
export class AuctionLotNotFoundError extends AuctionNotFoundError {
  constructor() {
    super();
    this.message = AuctionsErrorMessages.LOT_NOT_FOUND;
    this.name = "AuctionLotNotFoundError";
  }
}

export type { AuctionStatus, AuctionScheduleBucket };

export type AuctionListFilter =
  | "all_active"
  | AuctionStatus
  | AuctionScheduleBucket;

export type AuctionDateFilterField = "auctionDate" | "publishedAt";

export type LotBidderMapPreviewRow = {
  bidderId: number;
  bidderName: string;
  lotIds: number[];
  /** Selected lot display orders (sorted), for UI display. */
  lotDisplayOrders: number[];
  lotDisplayOrderFrom: number | null;
  lotDisplayOrderTo: number | null;
  emdRequired: number;
  /**
   * The bidder's already-blocked amount and EMD required for their existing +
   * newly selected lots combined — what the Full block is checked against on
   * submit. Undefined for bulk-import rows (each import row stands alone);
   * present for the interactive Attach Bidders preview.
   */
  alreadyBlocked?: number;
  combinedEmdRequired?: number;
  emdAvailable: number;
  isEmdWithClient: boolean;
  /**
   * Additional EMD that will be blocked by this attach (display only):
   * combined requirement minus what is already blocked. Null when EMD is with
   * the client.
   */
  emdAmount: number | null;
  error: string | null;
  /** 1-based Excel row number when produced by bulk import; omitted for UI preview. */
  rowNumber?: number;
};

export type LotBidderMapSubmitRow = {
  bidderId: number;
  lotIds: number[];
  isEmdWithClient: boolean;
};

export type LotBidderMapExportRow = {
  bidderId: number;
  bidderName: string;
  lotDisplayOrders: number[];
  emdDisplayOrders: number[];
  isEmdWithClient: boolean;
};

export type AuctionListItem = {
  auctionId: number;
  auctionNumber: string | null;
  clientId: number;
  clientName: string | null;
  auctionDate: string;
  publishedAt: string | null;
  lotCount: number;
  approvedLotCount: number;
  bidderCount: number;
  /** Earliest active lot start time-of-day (HH:mm:ss), or null if none. */
  lotStartTime: string | null;
  totalQty: number | null;
  soldQty: number | null;
  uom: string | null;
  status: AuctionStatus;
  scheduleBucket: AuctionScheduleBucket | null;
  needsApproval: boolean;
  hasCatalogue: boolean;
  hasTnc: boolean;
  catalogueUrl: string | null;
  tncUrl: string | null;
};

export type AuctionListCounts = Record<AuctionListFilter, number>;

export type AuctionListPhase = "creation" | "execution" | "settlement";

export type { AuctionsListSortBy };

export type AuctionListResult = {
  items: AuctionListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type AuctionStatsResult = {
  counts: AuctionListCounts;
};

export type AuctionsListParams = {
  search?: string;
  filter?: AuctionListFilter;
  phase?: AuctionListPhase;
  clientId?: number;
  month?: { year: number; month: number };
  dateField?: AuctionDateFilterField;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sortBy?: AuctionsListSortBy;
  sortOrder?: "asc" | "desc";
};


/** Columns needed to place the sealed-bid window on the schedule gate. */
const sealedGateColumns = {
  isSealedBid: auctions.isSealedBid,
  sealedBidDate: auctions.sealedBidDate,
  sealedBidStartTime: auctions.sealedBidStartTime,
  sealedBidEndTime: auctions.sealedBidEndTime,
};

/** Sealed-bid inputs for the schedule gates in `lib/auctions/status.ts`. */
function sealedGateInputOf(row: {
  isSealedBid: boolean;
  sealedBidDate: string | null;
  sealedBidStartTime: string | null;
  sealedBidEndTime: string | null;
}) {
  const window = sealedBidWindow(row);
  return {
    sealedBidStartAt: window?.startAt ?? null,
    sealedBidEndAt: window?.endAt ?? null,
  };
}

type SealedBidSettings = {
  isSealedBid: boolean;
  sealedBidDate: string | null;
  sealedBidStartTime: string | null;
  sealedBidEndTime: string | null;
};

/** Calendar day (YYYY-MM-DD) — the column stores the IST day as UTC midnight. */
function sealedDateKey(v: string | null): string | null {
  return v ? v.slice(0, 10) : null;
}

function sealedTimeKey(v: string | null): string | null {
  return v ? v.slice(0, 5) : null;
}

/**
 * Sealed-bid columns to write for a patch, validated against the merged row.
 * Turning sealed-bid off clears the window and sealed-only.
 */
export function mergeSealedBidPatch(
  current: SealedBidSettings,
  body: Partial<{
    isSealedBid: boolean;
    sealedBidDate: string | null;
    sealedBidStartTime: string | null;
    sealedBidEndTime: string | null;
  }>,
  opts: { windowLocked?: boolean } = {},
): Partial<SealedBidSettings> {
  // The admin editor resends the sealed fields on every save, so only a value
  // that actually differs counts as a change.
  const changed =
    (body.isSealedBid !== undefined && body.isSealedBid !== current.isSealedBid) ||
    (body.sealedBidDate !== undefined &&
      sealedDateKey(body.sealedBidDate) !== sealedDateKey(current.sealedBidDate)) ||
    (body.sealedBidStartTime !== undefined &&
      sealedTimeKey(body.sealedBidStartTime) !==
        sealedTimeKey(current.sealedBidStartTime)) ||
    (body.sealedBidEndTime !== undefined &&
      sealedTimeKey(body.sealedBidEndTime) !==
        sealedTimeKey(current.sealedBidEndTime));
  if (!changed) return {};
  if (opts.windowLocked) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.SEALED_BID_SETTINGS_LOCKED,
    );
  }
  if (body.isSealedBid === false) {
    return {
      isSealedBid: false,
      sealedBidDate: null,
      sealedBidStartTime: null,
      sealedBidEndTime: null,
    };
  }
  const merged: SealedBidSettings = {
    isSealedBid: body.isSealedBid ?? current.isSealedBid,
    sealedBidDate:
      body.sealedBidDate !== undefined ? body.sealedBidDate : current.sealedBidDate,
    sealedBidStartTime:
      body.sealedBidStartTime !== undefined
        ? body.sealedBidStartTime
        : current.sealedBidStartTime,
    sealedBidEndTime:
      body.sealedBidEndTime !== undefined
        ? body.sealedBidEndTime
        : current.sealedBidEndTime,
  };
  assertSealedBidSettings(merged);
  return merged;
}

/**
 * Structural checks shared by create, patch and publish: when sealed-bid is
 * on, date/start/end are required and end > start. The sealed-bid date
 * itself can't be before today (IST) — its time of day has no relationship
 * to the auction's or lots' schedule, so that's the only timing rule left.
 * This also lets the window be *rescheduled* forward at any time (even while
 * open or after it closed): the new date just has to be today or later.
 */
function assertSealedBidSettings(
  s: SealedBidSettings,
  opts: { now?: Date } = {},
) {
  if (!s.isSealedBid) return;
  if (!s.sealedBidDate) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.SEALED_BID_DATE_REQUIRED,
    );
  }
  if (!s.sealedBidStartTime) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.SEALED_BID_START_TIME_REQUIRED,
    );
  }
  if (!s.sealedBidEndTime) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.SEALED_BID_END_TIME_REQUIRED,
    );
  }
  if (s.sealedBidEndTime <= s.sealedBidStartTime) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.SEALED_BID_END_BEFORE_START,
    );
  }
  const today = auctionDateIsoForInstant(opts.now ?? new Date());
  if (sealedDateKey(s.sealedBidDate)! < sealedDateKey(today)!) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.SEALED_BID_WINDOW_START_MUST_BE_FUTURE,
    );
  }
}

/** The sealed-bid date must be on or before the auction date. */
export function assertSealedDateOnOrBeforeAuctionDate(
  s: SealedBidSettings,
  auctionDate: string,
) {
  if (!s.isSealedBid || !s.sealedBidDate) return;
  if (sealedDateKey(s.sealedBidDate)! > sealedDateKey(auctionDate)!) {
    const msg = AuctionsValidationMessages.SEALED_BID_DATE_AFTER_AUCTION_DATE;
    throw new AuctionValidationError(msg, { sealedBidDate: [msg] });
  }
}

/**
 * publishedAt must be strictly after now and on/before the auction's
 * calendar day (IST) — the same rule the admin form enforces client-side
 * (`refinePublishedAt`), re-checked here since create/update can be reached
 * without going through that form.
 */
export function assertPublishedAtWindow(
  publishedAt: string,
  auctionDate: string,
  opts: { now?: Date } = {},
) {
  if (!isPublishedAtAfterNow(publishedAt, opts.now ?? new Date())) {
    const msg = AuctionsValidationMessages.PUBLISHED_AT_MUST_BE_FUTURE;
    throw new AuctionValidationError(msg, { publishedAt: [msg] });
  }
  if (!isPublishedAtOnOrBeforeAuctionDate(publishedAt, auctionDate)) {
    const msg =
      AuctionsValidationMessages.PUBLISHED_AT_MUST_BE_ON_OR_BEFORE_AUCTION_DATE;
    throw new AuctionValidationError(msg, { publishedAt: [msg] });
  }
}

/**
 * On update, a changed publishedAt/auctionDate must also stay on or before
 * every existing active lot's configured start (auction day + lot start
 * time) — the same bound the Lot form enforces when a lot is saved. This
 * transitively also keeps publishedAt on or before every lot's end, since a
 * lot's end is always after its own start (enforced when the lot is
 * written), so the earliest end across lots is always later than the
 * earliest start across lots — no separate end check is reachable. With no
 * active lot starts yet, there's nothing to check against.
 */
async function assertPublishedAtAgainstExistingLots(
  auctionId: number,
  publishedAt: string,
  auctionDate: string,
) {
  const lots = await pgLotTimes(auctionId);
  if (!hasActiveLotStarts(lots, auctionDate)) return;
  const earliestStart = earliestLotStart(lots, auctionDate);
  if (earliestStart.getTime() < new Date(publishedAt).getTime()) {
    const msg =
      AuctionsValidationMessages.PUBLISHED_AT_MUST_BE_ON_OR_BEFORE_EARLIEST_LOT_START;
    throw new AuctionValidationError(msg, { publishedAt: [msg] });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

function isAuctionNumberUniqueViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const constraint =
    typeof err === "object" &&
    err !== null &&
    "constraint" in err &&
    typeof (err as { constraint: unknown }).constraint === "string"
      ? (err as { constraint: string }).constraint
      : "";
  return (
    constraint.includes("auctions_client_id_auction_number_active_uidx") ||
    constraint.includes("auction_number")
  );
}

function duplicateAuctionNumberError(): AuctionValidationError {
  const message = AuctionsValidationMessages.AUCTION_NUMBER_DUPLICATE;
  return new AuctionValidationError(message, {
    auctionNumber: [message],
  });
}

const ALL_FILTERS: AuctionListFilter[] = [
  "all_active",
  ...AUCTION_STATUSES,
  ...AUCTION_SCHEDULE_BUCKETS,
];

const PHASE_STATUSES: Record<AuctionListPhase, AuctionStatus[]> = {
  creation: ["draft", "archived"],
  execution: ["published"],
  settlement: ["closed"],
};

const SCHEDULE_BUCKET_SET = new Set<string>(AUCTION_SCHEDULE_BUCKETS);

function isScheduleBucketFilter(
  filter: AuctionListFilter,
): filter is AuctionScheduleBucket {
  return SCHEDULE_BUCKET_SET.has(filter);
}

/** A rejection that released the winner's EMD cannot be approved or cleared. */
async function assertLotDecisionsChangeable(
  auctionId: number,
  lotIds: number[] | "all",
): Promise<void> {
  const locked = await emdBlocksService.lotsReleasedOnRejection(auctionId, lotIds);
  if (locked.length === 0) return;
  throw new AuctionValidationError(
    AuctionsValidationMessages.LOT_REJECTION_LOCKED_EMD_RELEASED(
      (await emdLotsLabel(db, locked)) ?? "",
    ),
  );
}

/** Reject approving lots that lack winning price and bidder. */
async function assertLotsHaveWinningForApproval(
  auctionId: number,
  lotIds: number[] | "all",
) {
  if (lotIds !== "all" && lotIds.length === 0) return;

  const conditions = [
    eq(auctionLots.auctionId, auctionId),
    eq(auctionLots.isActive, true),
  ];
  if (lotIds !== "all") {
    conditions.push(inArray(auctionLots.id, lotIds));
  }

  const rows = await db
    .select({
      id: auctionLots.id,
      winningAmount: auctionLots.winningAmount,
      winnerBidderId: auctionLots.winnerBidderId,
    })
    .from(auctionLots)
    .where(and(...conditions));

  if (lotIds !== "all") {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missingWinner = lotIds.some((lotId) => {
      const row = byId.get(lotId);
      return !row || row.winningAmount == null || row.winnerBidderId == null;
    });
    if (missingWinner) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_APPROVAL_REQUIRES_WINNING,
      );
    }
    return;
  }

  const missingWinner = rows.some(
    (row) => row.winningAmount == null || row.winnerBidderId == null,
  );
  if (missingWinner) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.LOT_APPROVAL_REQUIRES_WINNING,
    );
  }
}

/**
 * Latest effective lot end as a real instant (matches Live Monitor /
 * listLive): COALESCE(extended_end_time, auction_date + end_time).
 * Covers no-bid extension, last-bid anti-sniping, and stagger.
 * Falls back to end of the auction day (IST) when no ends exist.
 */
function latestLotEndSql() {
  return sql`COALESCE(
    (
      SELECT MAX(
        COALESCE(
          ${auctionLots.extendedEndTime},
          (${auctions.auctionDate}::date + ${auctionLots.endTime}) AT TIME ZONE 'Asia/Kolkata'
        )
      )
      FROM ${auctionLots}
      WHERE ${auctionLots.auctionId} = ${auctions.id}
        AND ${auctionLots.isActive} = true
        AND (
          ${auctionLots.extendedEndTime} IS NOT NULL
          OR ${auctionLots.endTime} IS NOT NULL
        )
    ),
    ((${auctions.auctionDate}::date + interval '1 day' - interval '1 millisecond') AT TIME ZONE 'Asia/Kolkata')
  )`;
}

function scheduleBucketCondition(bucket: AuctionScheduleBucket): SQL {
  const earliest = earliestLotStartSql();
  const latestEnd = latestLotEndSql();
  // "Today" in IST — the calendar day the live monitor treats as current. A
  // lot's start always falls on its auction day, so bucketing on auction_date
  // (IST) matches comparing the earliest start to today's IST boundaries.
  const istToday = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;

  if (bucket === "future") {
    // Published and scheduled for a day after today (IST).
    return and(
      eq(auctions.status, "published"),
      sql`(${auctions.auctionDate})::date > ${istToday}`,
    )!;
  }
  if (bucket === "upcoming") {
    // Published, scheduled for today (IST), not yet started.
    return and(
      eq(auctions.status, "published"),
      sql`(${auctions.auctionDate})::date = ${istToday}`,
      sql`${earliest} > now()`,
    )!;
  }
  // live: published, today (IST), started, schedule not yet over.
  return and(
    eq(auctions.status, "published"),
    sql`(${auctions.auctionDate})::date = ${istToday}`,
    sql`${earliest} <= now()`,
    sql`${latestEnd} > now()`,
  )!;
}

function clampPagination(page: number, pageSize: number) {
  const clampedPage = Math.max(1, page);
  const clampedPageSize = Math.max(1, Math.min(500, pageSize));
  return {
    page: clampedPage,
    pageSize: clampedPageSize,
    offset: (clampedPage - 1) * clampedPageSize,
  };
}

function filterCondition(
  filter: AuctionListFilter,
  phase?: AuctionListPhase,
): SQL {
  if (filter !== "all_active") {
    if (isScheduleBucketFilter(filter)) {
      return scheduleBucketCondition(filter);
    }
    return eq(auctions.status, filter);
  }
  if (phase) {
    const statuses = PHASE_STATUSES[phase];
    return sql`${auctions.status} IN (${sql.join(
      statuses.map((s) => sql`${s}`),
      sql`, `,
    )})`;
  }
  // All statuses, including archived.
  return sql`true`;
}

function buildDateCondition(
  opts: Pick<AuctionsListParams, "dateField" | "dateFrom" | "dateTo">,
): SQL | undefined {
  if (!opts.dateFrom) return undefined;
  const column =
    opts.dateField === "publishedAt"
      ? auctions.publishedAt
      : auctions.auctionDate;
  if (opts.dateTo) {
    return sql`${column}::date >= CAST(${opts.dateFrom} AS date) AND ${column}::date <= CAST(${opts.dateTo} AS date)`;
  }
  return sql`${column}::date >= CAST(${opts.dateFrom} AS date)`;
}

function buildBaseConditions(
  opts: Pick<
    AuctionsListParams,
    "search" | "clientId" | "month" | "dateField" | "dateFrom" | "dateTo"
  >,
): SQL[] {
  const conditions: SQL[] = [];
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`;
    conditions.push(
      or(
        ilike(auctions.auctionNumber, term),
        ilike(clients.companyName, term),
        ilike(sql`cast(${auctions.id} as text)`, term),
        ilike(sql`cast(${auctions.clientId} as text)`, term),
      )!,
    );
  }
  if (opts.clientId) {
    conditions.push(eq(auctions.clientId, opts.clientId));
  }
  if (opts.month) {
    const y = opts.month.year;
    const m = opts.month.month;
    const pad = (n: number) => String(n).padStart(2, "0");
    const start = `${y}-${pad(m)}-01T00:00:00`;
    const nextMonth = m === 12 ? 1 : m + 1;
    const nextYear = m === 12 ? y + 1 : y;
    const end = `${nextYear}-${pad(nextMonth)}-01T00:00:00`;
    conditions.push(
      sql`${auctions.auctionDate} >= ${start} AND ${auctions.auctionDate} < ${end}`,
    );
  }
  const dateCondition = buildDateCondition(opts);
  if (dateCondition) {
    conditions.push(dateCondition);
  } else {
    if (opts.dateFrom) {
      conditions.push(gte(auctions.auctionDate, opts.dateFrom));
    }
    if (opts.dateTo) {
      conditions.push(lte(auctions.auctionDate, opts.dateTo));
    }
  }
  return conditions;
}

function mapAuctionType(t: string | null): string | null {
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export class AuctionsService {
  async list(opts: AuctionsListParams = {}): Promise<AuctionListResult> {
    const filter = opts.filter ?? "all_active";
    const { page, pageSize, offset } = clampPagination(
      opts.page ?? 1,
      opts.pageSize ?? 10,
    );
    const conditions = [
      filterCondition(filter, opts.phase),
      ...buildBaseConditions(opts),
    ];
    const where = and(...conditions);
    const orderBy = buildAuctionListOrderBy(opts.sortBy, opts.sortOrder);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(auctions)
      .leftJoin(clients, eq(clients.id, auctions.clientId))
      .where(where);

    const rows = await db
      .select({
        auctionId: auctions.id,
        auctionNumber: auctions.auctionNumber,
        clientId: auctions.clientId,
        clientName: clients.companyName,
        auctionDate: auctions.auctionDate,
        publishedAt: auctions.publishedAt,
        status: auctions.status,
      })
      .from(auctions)
      .leftJoin(clients, eq(clients.id, auctions.clientId))
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    const items = await Promise.all(
      rows.map(async (r) => {
        const stats = await pgAuctionStats(r.auctionId).catch(() => null);
        const lotCount = stats?.lotsTotal ?? 0;
        const approvedLotCount = stats?.lotsApproved ?? 0;
        const lots = await pgLotTimes(r.auctionId).catch(() => []);
        const scheduleBucket =
          r.status === "published"
            ? deriveScheduleBucket(r.auctionDate, lots)
            : null;
        const lotStartTimes = lots
          .map((l) => l.lotStartTime)
          .filter((t): t is string => t != null && t !== "");
        const lotStartTime =
          lotStartTimes.length > 0
            ? lotStartTimes.reduce((a, b) => (a < b ? a : b))
            : null;
        return {
          auctionId: r.auctionId,
          auctionNumber: r.auctionNumber ?? null,
          clientId: r.clientId,
          clientName: r.clientName ?? null,
          auctionDate: r.auctionDate,
          publishedAt: r.publishedAt ?? null,
          lotCount,
          approvedLotCount,
          bidderCount: stats?.bidderCount ?? 0,
          lotStartTime,
          totalQty: stats?.totalQty ?? null,
          soldQty: stats?.soldQty ?? null,
          uom: stats?.uom ?? null,
          status: r.status,
          scheduleBucket,
          needsApproval: lotCount > 0 && approvedLotCount < lotCount,
          hasCatalogue: stats?.catalogueUploaded ?? false,
          hasTnc: stats?.tncUploaded ?? false,
          catalogueUrl: stats?.currentCatalogue?.downloadUrl ?? null,
          tncUrl: stats?.currentTnc?.downloadUrl ?? null,
        };
      }),
    );

    return {
      items,
      total: countRow?.total ?? 0,
      page,
      pageSize,
    };
  }

  async getStats(
    opts: Pick<
      AuctionsListParams,
      "search" | "clientId" | "month" | "dateField" | "dateFrom" | "dateTo"
    > = {},
  ): Promise<AuctionStatsResult> {
    const counts = await this.counts(opts);
    return { counts };
  }

  async counts(
    opts: Pick<
      AuctionsListParams,
      "search" | "clientId" | "month" | "dateField" | "dateFrom" | "dateTo"
    > = {},
  ): Promise<AuctionListCounts> {
    const baseConditions = buildBaseConditions(opts);
    const baseWhere =
      baseConditions.length > 0 ? and(...baseConditions) : undefined;

    const results = await Promise.all(
      ALL_FILTERS.map(async (f) => {
        const conds = [filterCondition(f)];
        if (baseWhere) conds.push(baseWhere);
        const countRows = await db
          .select({ n: sql<number>`COUNT(*)` })
          .from(auctions)
          .leftJoin(clients, eq(clients.id, auctions.clientId))
          .where(and(...conds));
        return [f, Number(countRows[0]?.n ?? 0)] as const;
      }),
    );

    return Object.fromEntries(results) as AuctionListCounts;
  }

  async getById(auctionId: number) {
    const rows = await db
      .select({
        auctionId: auctions.id,
        auctionNumber: auctions.auctionNumber,
        clientId: auctions.clientId,
        clientName: clients.companyName,
        auctionType: auctions.auctionType,
        auctionDate: auctions.auctionDate,
        publishedAt: auctions.publishedAt,
        status: auctions.status,
        closedAt: auctions.closedAt,
        consolidatedEmdAmount: auctions.consolidatedEmdAmount,
        ...sealedGateColumns,
        isStartBidPricePlusIncrement: auctions.isStartBidPricePlusIncrement,
        ipAddressRestrictionEnabled: auctions.ipAddressRestrictionEnabled,
        isRankBased: auctions.isRankBased,
        isNoBidExtension: auctions.isNoBidExtension,
        noBidExtensionInterval: auctions.noBidExtensionInterval,
        noBidExtensionCountMax: auctions.noBidExtensionCountMax,
        auctionIsStaggered: auctions.isStaggered,
        clientIsStaggered: clients.isStaggered,
        clientStaggerInterval: clients.staggerInterval,
      })
      .from(auctions)
      .leftJoin(clients, eq(clients.id, auctions.clientId))
      .where(eq(auctions.id, auctionId))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AuctionNotFoundError();

    const stats = await pgAuctionStats(auctionId).catch(() => ({
      lotsTotal: 0,
      lotsApproved: 0,
      lotsPreview: [],
      lotsWithBidders: 0,
      catalogueUploaded: false,
      currentCatalogue: null,
      tncUploaded: false,
      currentTnc: null,
      lotEmdSet: false,
      lotEmdCount: 0,
      biddersMapped: false,
      bidderCount: 0,
      totalQty: null,
      soldQty: null,
      uom: null,
    }));

    const allLotsApproved =
      stats.lotsTotal > 0 && stats.lotsApproved === stats.lotsTotal;
    const flags = statusFlags(row.status, allLotsApproved);
    const lotTimes = await pgLotTimes(auctionId).catch(() => []);
    const scheduleBucket =
      row.status === "published"
        ? deriveScheduleBucket(row.auctionDate, lotTimes)
        : null;
    const gateInput = {
      status: row.status as AuctionStatus,
      auctionDate: row.auctionDate,
      lots: lotTimes,
      ...sealedGateInputOf(row),
    };
    const sealedBidCount = row.isSealedBid
      ? await db
          .select({ n: sql<number>`COUNT(*)` })
          .from(auctionSealedBids)
          .where(
            and(
              eq(auctionSealedBids.auctionId, auctionId),
              eq(auctionSealedBids.isRemoved, false),
            ),
          )
          .then((r) => Number(r[0]?.n ?? 0))
      : 0;

    const [additionalFieldsCount, clientHasAdditionalFields] =
      await Promise.all([
        auctionAdditionalFieldsService
          .countSelectedFields(auctionId)
          .catch(() => 0),
        auctionAdditionalFieldsService
          .clientHasActiveFields(row.clientId)
          .catch(() => false),
      ]);

    return {
      auctionId: row.auctionId,
      auctionNumber: row.auctionNumber ?? null,
      clientId: row.clientId,
      clientName: row.clientName ?? null,
      auctionType: mapAuctionType(row.auctionType),
      auctionDate: row.auctionDate,
      publishedAt: row.publishedAt,
      closedAt: row.closedAt,
      isPublished: flags.isPublished,
      isApproved: flags.isApproved,
      isClosed: flags.isClosed,
      isArchived: flags.isArchived,
      isCanceled: flags.isCanceled,
      status: row.status,
      scheduleBucket,
      canArchive: canArchiveAuction(gateInput),
      canUnpublish: canUnpublishAuction(gateInput) && !stats.biddersMapped,
      /** Move to Draft would be allowed, but bidders are still attached. */
      unpublishBlockedByBidders:
        canUnpublishAuction(gateInput) && stats.biddersMapped,
      /** Sealed-bid window state, or null when the auction has none. */
      sealedWindowState: sealedBidWindowState(row),
      /** Sealed-bid settings are editable any time the auction is draft/published. */
      canEditSealedWindow: canEditSealedBidWindow(gateInput),
      /** Active (non-removed) sealed bids — rescheduling the window disables these. */
      sealedBidCount,
      /** Lot staggering can be forced on/off via Corrections while the auction is live. */
      canCorrectStagger:
        scheduleBucket === "live" && (row.clientStaggerInterval ?? 0) > 0,
      canRestore: canRestoreAuction(row.status as AuctionStatus),
      canEditContent: canEditAuctionContent(gateInput),
      /** Lot settings are editable any time before the auction closes. */
      canEditLots: canEditLotContent(row.status as AuctionStatus),
      /**
       * Auction Settings fields with no other status-aware gate (number,
       * type, published-at, no-bid extension, rank-based, IP restriction...).
       */
      canEditSettings: canEditAuctionSettingsFields(row.status as AuctionStatus),
      /** EMD config and Attach Bidders are editable only while published. */
      canEditExecutionContent: canEditExecutionContent(row.status as AuctionStatus),
      /** Stored values keep the tab reachable after the client deactivates its fields. */
      hasAdditionalFields:
        clientHasAdditionalFields || additionalFieldsCount > 0,
      settings: {
        emdAmount: row.consolidatedEmdAmount
          ? Number(row.consolidatedEmdAmount)
          : null,
        isSealedBid: row.isSealedBid,
        sealedBidDate: row.sealedBidDate,
        sealedBidStartTime: row.sealedBidStartTime,
        sealedBidEndTime: row.sealedBidEndTime,
        isStartBidPricePlusIncrement: row.isStartBidPricePlusIncrement,
        ipRestriction: row.ipAddressRestrictionEnabled,
        isRankBased: row.isRankBased,
        isNoBidExtension: row.isNoBidExtension,
        noBidExtensionInterval: row.noBidExtensionInterval,
        noBidExtensionCountMax: row.noBidExtensionCountMax,
        isStaggered: row.auctionIsStaggered ?? row.clientIsStaggered ?? false,
        staggerInterval: row.clientStaggerInterval ?? 0,
      },
      lotsTotal: stats.lotsTotal,
      lotsPreview: stats.lotsPreview,
      totalQty: stats.totalQty,
      soldQty: stats.soldQty,
      uom: stats.uom,
      setupProgress: {
        lotsLoaded: stats.lotsTotal > 0,
        catalogueUploaded: stats.catalogueUploaded,
        currentCatalogue: stats.currentCatalogue,
        tncUploaded: stats.tncUploaded,
        currentTnc: stats.currentTnc,
        lotEmdSet: stats.lotEmdSet,
        lotEmdCount: stats.lotEmdCount,
        biddersMapped: stats.biddersMapped,
        lotsWithBidders: stats.lotsWithBidders,
        additionalFieldsCount,
      },
    };
  }

  async update(auctionId: number, body: PatchAuctionBody, userId: number) {
    const rows = await db
      .select({
        status: auctions.status,
        auctionDate: auctions.auctionDate,
        publishedAt: auctions.publishedAt,
        ...sealedGateColumns,
        clientId: auctions.clientId,
        consolidatedEmdAmount: auctions.consolidatedEmdAmount,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AuctionNotFoundError();

    this.assertAuctionSettingsFieldsEditable(row.status as AuctionStatus, body);

    const patch: Partial<typeof auctions.$inferInsert> = {
      updatedAt: formatUtcNow(),
      updatedBy: userId,
    };

    // clientId is immutable after create — not accepted on patch
    if (body.auctionNumber !== undefined) {
      try {
        patch.auctionNumber = await this.resolveAuctionNumber(
          row.clientId,
          body.auctionNumber,
        );
        await this.assertAuctionNumberAvailable(
          row.clientId,
          patch.auctionNumber,
          auctionId,
        );
      } catch (err) {
        if (err instanceof AuctionValidationError) throw err;
        if (err instanceof Error) {
          throw new AuctionValidationError(err.message);
        }
        throw err;
      }
    }
    if (body.auctionType !== undefined) patch.auctionType = body.auctionType;
    if (body.consolidatedEmdAmount !== undefined) {
      const current =
        row.consolidatedEmdAmount != null
          ? Number(row.consolidatedEmdAmount)
          : null;
      if (body.consolidatedEmdAmount !== current) {
        if (!canEditExecutionContent(row.status as AuctionStatus)) {
          throw new AuctionValidationError(
            AuctionsValidationMessages.EMD_WRITES_REQUIRE_PUBLISHED,
          );
        }
        await this.assertNoBiddersAttached(auctionId);
      }
      patch.consolidatedEmdAmount =
        body.consolidatedEmdAmount != null
          ? String(body.consolidatedEmdAmount)
          : null;
    }
    let isReschedulingClosedAuction = false;
    if (body.auctionDate !== undefined) {
      const auctionDateChanged = body.auctionDate !== row.auctionDate;
      if (auctionDateChanged && (await pgAuctionHasBids(auctionId))) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.AUCTION_DATE_EDIT_REQUIRES_NO_BIDS,
          {
            auctionDate: [
              AuctionsValidationMessages.AUCTION_DATE_EDIT_REQUIRES_NO_BIDS,
            ],
          },
        );
      }
      patch.auctionDate = body.auctionDate;
      // Rescheduling a closed (necessarily bid-free, per the check above)
      // auction is a republish: it goes back to published on the new date
      // rather than sitting "closed" with a future date.
      if (auctionDateChanged && row.status === "closed") {
        patch.status = "published";
        patch.closedAt = null;
        isReschedulingClosedAuction = true;
      }
    }
    if (body.publishedAt !== undefined) {
      patch.publishedAt = body.publishedAt;
    }
    if (body.publishedAt !== undefined || body.auctionDate !== undefined) {
      const effectivePublishedAt = patch.publishedAt ?? row.publishedAt;
      const effectiveAuctionDate = patch.auctionDate ?? row.auctionDate;
      if (effectivePublishedAt) {
        assertPublishedAtWindow(effectivePublishedAt, effectiveAuctionDate);
        await assertPublishedAtAgainstExistingLots(
          auctionId,
          effectivePublishedAt,
          effectiveAuctionDate,
        );
      }
    }
    if (body.noBidExtensionInterval !== undefined) {
      patch.noBidExtensionInterval = body.noBidExtensionInterval;
    }
    if (body.noBidExtensionCountMax !== undefined) {
      patch.noBidExtensionCountMax = body.noBidExtensionCountMax;
    }
    if (body.isNoBidExtension !== undefined) {
      patch.isNoBidExtension = body.isNoBidExtension;
    }
    if (body.isStartBidPricePlusIncrement !== undefined) {
      patch.isStartBidPricePlusIncrement = body.isStartBidPricePlusIncrement;
    }
    const sealedPatch = mergeSealedBidPatch(row, body, {
        // Only a draft/published auction can touch its sealed-bid settings;
        // the window itself is otherwise editable at any time — even while
        // open or after it has closed — so a reschedule can move it forward.
        windowLocked: !canEditSealedBidWindow({
          status: row.status as AuctionStatus,
          auctionDate: row.auctionDate,
          ...sealedGateInputOf(row),
        }),
    });
    Object.assign(patch, sealedPatch);
    const sealedFieldsChanged = Object.keys(sealedPatch).length > 0;
    // Moving the sealed window or the auction date can put the sealed date
    // after the auction date.
    if (
      sealedFieldsChanged ||
      (patch.auctionDate !== undefined && patch.auctionDate !== row.auctionDate)
    ) {
      assertSealedDateOnOrBeforeAuctionDate(
        { ...row, ...sealedPatch },
        patch.auctionDate ?? row.auctionDate,
      );
    }
    if (body.ipAddressRestrictionEnabled !== undefined) {
      patch.ipAddressRestrictionEnabled = body.ipAddressRestrictionEnabled;
    }
    if (body.isRankBased !== undefined) patch.isRankBased = body.isRankBased;

    const noBidSettingsTouched =
      body.noBidExtensionInterval !== undefined ||
      body.noBidExtensionCountMax !== undefined ||
      body.isNoBidExtension !== undefined;

    try {
      if (sealedFieldsChanged) {
        // Rescheduling the sealed-bid window invalidates any bids placed
        // under the old one — soft-delete them in the same transaction as
        // the window change, same shape as "Remove Bid" on auction_bid_logs.
        await db.transaction(async (tx) => {
          await tx
            .update(auctionSealedBids)
            .set({
              isRemoved: true,
              removedAt: formatUtcNow(),
              removedBy: userId,
            })
            .where(
              and(
                eq(auctionSealedBids.auctionId, auctionId),
                eq(auctionSealedBids.isRemoved, false),
              ),
            );
          await tx.update(auctions).set(patch).where(eq(auctions.id, auctionId));
        });
      } else {
        await db.update(auctions).set(patch).where(eq(auctions.id, auctionId));
      }
    } catch (err) {
      if (isAuctionNumberUniqueViolation(err)) {
        throw duplicateAuctionNumberError();
      }
      throw err;
    }

    // Lot create/import snapshots auctions.is_no_bid_extension onto each lot.
    // The live no-bid engine requires l.is_no_bid_extension, so re-sync when
    // settings change (e.g. enable after lots were added while extension was off).
    if (noBidSettingsTouched) {
      await this.syncLotNoBidExtensionFromAuction(auctionId, userId);
    }

    // A prior no-bid-extension run can leave extended_end_time in the past
    // (on the old auction_date). Clear it so the new date's scheduled end is
    // what counts — otherwise the republished auction reads as already ended.
    if (isReschedulingClosedAuction) {
      await clearLotExtensionState(db, auctionId, "all-active", userId);
    }
  }

  /**
   * Align active, unbid lots' is_no_bid_extension with the auction's current
   * no-bid settings. Clears stop metadata when re-enabling (pre-live only path).
   */
  private async syncLotNoBidExtensionFromAuction(
    auctionId: number,
    userId: number,
  ): Promise<void> {
    const settingsRows = await db
      .select({
        isNoBidExtension: auctions.isNoBidExtension,
        noBidExtensionInterval: auctions.noBidExtensionInterval,
        noBidExtensionCountMax: auctions.noBidExtensionCountMax,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const settings = settingsRows[0];
    if (!settings) return;

    const enabled =
      settings.isNoBidExtension !== false &&
      (settings.noBidExtensionInterval ?? 0) > 0 &&
      (settings.noBidExtensionCountMax ?? 0) > 0;

    await db
      .update(auctionLots)
      .set({
        isNoBidExtension: enabled,
        ...(enabled
          ? {
              noBidExtensionStoppedAt: null,
              noBidExtensionStoppedBy: null,
            }
          : {}),
        updatedAt: formatUtcNow(),
        updatedBy: userId,
      })
      .where(
        and(
          eq(auctionLots.auctionId, auctionId),
          eq(auctionLots.isActive, true),
          eq(auctionLots.bidCount, 0),
        ),
      );
  }

  async create(
    body: {
      clientId: number;
      auctionNumber: string | null;
      auctionType: string;
      emdAmount: number | null;
      auctionDate: string;
      publishedAt: string;
      noBidExtensionInterval: number | null;
      noBidExtensionCountMax: number | null;
      isNoBidExtension: boolean | null;
      isStartBidPricePlusIncrement: boolean | null;
      isSealedBid: boolean;
      sealedBidDate?: string | null;
      sealedBidStartTime?: string | null;
      sealedBidEndTime?: string | null;
      ipAddressRestrictionEnabled: boolean | null;
      isRankBased: boolean;
    },
    userId: number,
  ) {
    const sealed: SealedBidSettings = body.isSealedBid
      ? {
          isSealedBid: true,
          sealedBidDate: body.sealedBidDate ?? null,
          sealedBidStartTime: body.sealedBidStartTime ?? null,
          sealedBidEndTime: body.sealedBidEndTime ?? null,
        }
      : {
          isSealedBid: false,
          sealedBidDate: null,
          sealedBidStartTime: null,
          sealedBidEndTime: null,
        };
    assertSealedBidSettings(sealed);
    assertSealedDateOnOrBeforeAuctionDate(sealed, body.auctionDate);
    assertPublishedAtWindow(body.publishedAt, body.auctionDate);

    const maxId = await db
      .select({ id: sql<number>`COALESCE(MAX(${auctions.id}), 0)` })
      .from(auctions);
    const nextId = Number(maxId[0]?.id ?? 0) + 1;

    const auctionType =
      body.auctionType.toLowerCase() === "reverse" ? "reverse" : "forward";

    let auctionNumber: string | null;
    try {
      auctionNumber = await this.resolveAuctionNumber(
        body.clientId,
        body.auctionNumber,
      );
      await this.assertAuctionNumberAvailable(body.clientId, auctionNumber);
    } catch (err) {
      if (err instanceof AuctionValidationError) throw err;
      if (err instanceof Error) {
        throw new AuctionValidationError(err.message);
      }
      throw err;
    }

    try {
      await db.insert(auctions).values({
        id: nextId,
        clientId: body.clientId,
        auctionNumber,
        auctionType,
        consolidatedEmdAmount:
          body.emdAmount != null ? String(body.emdAmount) : null,
        auctionDate: body.auctionDate,
        publishedAt: body.publishedAt,
        status: "draft",
        ...sealed,
        isStartBidPricePlusIncrement: body.isStartBidPricePlusIncrement ?? false,
        ipAddressRestrictionEnabled: body.ipAddressRestrictionEnabled ?? false,
        isRankBased: body.isRankBased,
        isNoBidExtension: body.isNoBidExtension ?? true,
        noBidExtensionInterval: body.noBidExtensionInterval,
        noBidExtensionCountMax: body.noBidExtensionCountMax ?? 0,
        createdBy: userId,
      });
    } catch (err) {
      if (isAuctionNumberUniqueViolation(err)) {
        throw duplicateAuctionNumberError();
      }
      throw err;
    }

    try {
      await pgCopyClientTncToAuction({
        clientId: body.clientId,
        auctionId: nextId,
        userId,
      });
    } catch (err) {
      console.error(
        `Failed to copy client TnC to auction ${nextId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    return { auctionId: nextId };
  }

  async publish(auctionId: number, userId: number) {
    const rows = await db
      .select({
        status: auctions.status,
        auctionDate: auctions.auctionDate,
        ...sealedGateColumns,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AuctionNotFoundError();
    if (row.status !== "draft") {
      throw new AuctionValidationError(
        AuctionsValidationMessages.PUBLISH_REQUIRES_DRAFT,
      );
    }

    const stats = await pgAuctionStats(auctionId);
    if (stats.lotsTotal <= 0) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.PUBLISH_REQUIRES_LOTS,
      );
    }
    if (!stats.catalogueUploaded) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.PUBLISH_REQUIRES_CATALOGUE,
      );
    }
    if (!stats.tncUploaded) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.PUBLISH_REQUIRES_TNC,
      );
    }

    const lots = await pgLotTimes(auctionId);
    // Re-validates the window (including that its date hasn't lapsed) even
    // though create/patch already checked it — time may have passed since
    // the last save.
    if (row.isSealedBid) {
      assertSealedBidSettings(row);
      assertSealedDateOnOrBeforeAuctionDate(row, row.auctionDate);
    }
    if (hasEarliestLotStartPassed(lots, row.auctionDate)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.PUBLISH_EARLIEST_LOT_START_PASSED,
      );
    }

    const now = formatUtcNow();

    const result = await db
      .update(auctions)
      .set({
        status: "published",
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(auctions.id, auctionId))
      .returning({ id: auctions.id });
    if (result.length === 0) throw new AuctionNotFoundError();
  }

  /** Explicit "Move to Draft" — the only way a published auction is unpublished. */
  async unpublish(auctionId: number, userId: number) {
    const rows = await db
      .select({
        status: auctions.status,
        auctionDate: auctions.auctionDate,
        ...sealedGateColumns,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AuctionNotFoundError();
    if (row.status !== "published") {
      throw new AuctionValidationError(
        AuctionsValidationMessages.UNPUBLISH_REQUIRES_PUBLISHED,
      );
    }
    const lots = await pgLotTimes(auctionId).catch(() => []);
    if (
      !canUnpublishAuction({
        status: row.status as AuctionStatus,
        auctionDate: row.auctionDate,
        lots,
        ...sealedGateInputOf(row),
      })
    ) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.UNPUBLISH_NOT_ALLOWED_BIDDING_STARTED,
      );
    }
    // Attached bidders hold EMD blocks against the published auction; they
    // must be detached (releasing those blocks) before it can go back to draft.
    const lotBidders = await pgLotBidderSummary(auctionId);
    if (lotBidders.some((l) => l.bidderCount > 0)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.UNPUBLISH_REQUIRES_BIDDERS_DETACHED,
      );
    }

    const result = await db
      .update(auctions)
      .set({
        status: "draft",
        updatedAt: formatUtcNow(),
        updatedBy: userId,
      })
      .where(and(eq(auctions.id, auctionId), eq(auctions.status, "published")))
      .returning({ id: auctions.id });
    if (result.length === 0) throw new AuctionNotFoundError();
  }

  async archive(auctionId: number, userId: number) {
    const rows = await db
      .select({
        status: auctions.status,
        auctionDate: auctions.auctionDate,
        ...sealedGateColumns,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AuctionNotFoundError();
    const lots = await pgLotTimes(auctionId).catch(() => []);
    if (
      !canArchiveAuction({
        status: row.status as AuctionStatus,
        auctionDate: row.auctionDate,
        lots,
        ...sealedGateInputOf(row),
      })
    ) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.ARCHIVE_NOT_ALLOWED,
      );
    }

    const now = formatUtcNow();
    const result = await db
      .update(auctions)
      .set({
        status: "archived",
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(auctions.id, auctionId))
      .returning({ id: auctions.id });
    if (result.length === 0) throw new AuctionNotFoundError();
  }

  async restore(auctionId: number, userId: number) {
    const rows = await db
      .select({ status: auctions.status })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AuctionNotFoundError();
    if (!canRestoreAuction(row.status as AuctionStatus)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.RESTORE_REQUIRES_ARCHIVED,
      );
    }

    const now = formatUtcNow();
    const result = await db
      .update(auctions)
      .set({
        status: "draft",
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(auctions.id, auctionId))
      .returning({ id: auctions.id });
    if (result.length === 0) throw new AuctionNotFoundError();
  }

  async listLots(auctionId: number, opts: AuctionLotsListParams = {}) {
    await this.assertExists(auctionId);
    return pgListLotsPaginated(auctionId, opts);
  }

  async withdrawLot(auctionId: number, lotId: number, userId: number) {
    await this.assertEditableForLotWrites(auctionId);
    // A published auction must keep at least one lot.
    const before = await pgAuctionStats(auctionId);
    if (before.lotsTotal <= 1) await this.assertDraftStatus(auctionId);
    const result = await pgWithdrawLot(auctionId, lotId, userId);
    if (result === "not_found") throw new AuctionLotNotFoundError();
    if (result === "already_withdrawn") {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_ALREADY_WITHDRAWN,
      );
    }
  }

  async deleteAllLots(auctionId: number) {
    await this.assertEditableForLotWrites(auctionId);
    // Deletes bids and lot-bidder maps without releasing EMD blocks — only
    // safe while the auction is a draft.
    await this.assertDraftStatus(auctionId);
    return { deleted: await pgDeleteAllLots(auctionId) };
  }

  async createLot(auctionId: number, body: CreateLotBody, userId: number) {
    await this.assertDraftForLotWrites(auctionId);
    await this.assertLotWriteCrossFields(auctionId, body);
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();
    try {
      const lotId = await pgCreateLot(auctionId, clientId, body, userId);
      return { lotId };
    } catch (err) {
      if (err instanceof Error) {
        throw new AuctionValidationError(err.message);
      }
      throw err;
    }
  }

  async addBidderPoolEntries(
    auctionId: number,
    bidderIds: number[],
    userId: number,
  ) {
    await this.assertDraftForLotWrites(auctionId);
    await this.assertBiddersVerified(bidderIds);
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();
    const added = await pgAddBidderPoolEntries(
      auctionId,
      clientId,
      bidderIds,
      userId,
    );
    return { added };
  }

  async setLotBidders(
    auctionId: number,
    lotId: number,
    bidderIds: number[],
    userId: number,
  ) {
    await this.assertDraftForLotWrites(auctionId);
    await this.assertBiddersVerified(bidderIds);
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();
    const lot = await pgGetLot(auctionId, lotId);
    if (!lot) throw new AuctionLotNotFoundError();
    await pgSetLotBidders(auctionId, clientId, lotId, bidderIds, userId);
  }

  async bulkMapBidders(
    auctionId: number,
    mappings: Array<{ lotId: number; bidderIds: number[] }>,
    userId: number,
  ) {
    await this.assertDraftForLotWrites(auctionId);
    await this.assertBiddersVerified(mappings.flatMap((m) => m.bidderIds));
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();
    await pgBulkMapBidders(auctionId, clientId, mappings, userId);
  }

  async getLot(auctionId: number, lotId: number) {
    await this.assertExists(auctionId);
    const lot = await pgGetLot(auctionId, lotId);
    if (!lot) throw new AuctionLotNotFoundError();

    const [mappedBidders, correctionWinnerCandidates, items, winnerName, isClosed] =
      await Promise.all([
        pgLotMappedBidders(auctionId, lotId),
        pgCorrectionWinnerCandidates(lot.clientId, auctionId, lotId),
        pgLotItems(lot.clientId, auctionId, lotId),
        pgWinnerName(lot.winnerCompId),
        pgIsLotClosed(auctionId, lotId),
      ]);

    return {
      lot: {
        ...lot,
        isClosed,
        winnerName,
        items,
        mappedBidders,
        correctionWinnerCandidates,
      },
    };
  }

  /**
   * Paginated bid history for a lot (settlement No. of Bids dialog).
   * Ordered best amount first (highest forward / lowest reverse), then newest.
   */
  async lotBidsPaginated(
    auctionId: number,
    lotId: number,
    opts: { page?: number; pageSize?: number } = {},
  ) {
    await this.assertExists(auctionId);
    const lot = await pgGetLot(auctionId, lotId);
    if (!lot) throw new AuctionLotNotFoundError();

    const { page, pageSize, offset } = clampPagination(
      opts.page ?? 1,
      opts.pageSize ?? 10,
    );

    const [auction] = await db
      .select({ auctionType: auctions.auctionType })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const amountOrder =
      auction?.auctionType === "reverse" ? sql`ASC` : sql`DESC`;

    const [countRow] = await db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total
      FROM auction_bids b
      WHERE b.lot_id = ${lotId} AND b.auction_id = ${auctionId}
    `).then((r) => r.rows);

    const res = await db.execute<{
      id: number;
      bidder_id: number;
      bidder_name: string | null;
      amount: string;
      is_proxy: boolean;
      proxy_amount: string | null;
      placed_at: string | null;
    }>(sql`
      SELECT b.id, b.bidder_id, bd.company_name AS bidder_name,
             b.amount, b.is_proxy, b.proxy_amount,
             to_char(b.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS placed_at
      FROM auction_bids b
      LEFT JOIN bidders bd ON bd.id = b.bidder_id
      WHERE b.lot_id = ${lotId} AND b.auction_id = ${auctionId}
      ORDER BY b.amount ${amountOrder}, COALESCE(b.committed_at, b.created_at) ASC, b.id ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `);

    return {
      items: res.rows.map((r) => {
        const isProxy = r.is_proxy === true;
        return {
          id: r.id,
          bidderId: r.bidder_id,
          bidderName: r.bidder_name,
          amount: Number(r.amount),
          bidType: (isProxy ? "proxy" : "manual") as "proxy" | "manual",
          proxyAmount: isProxy
            ? r.proxy_amount != null
              ? Number(r.proxy_amount)
              : 0
            : 0,
          placedAt: r.placed_at,
        };
      }),
      total: countRow?.total ?? 0,
      page,
      pageSize,
    };
  }

  /** Distinct bidders who placed a bid on the lot (settlement / live Bidder Log). */
  async lotBidBidders(auctionId: number, lotId: number) {
    await this.assertExists(auctionId);
    const lot = await pgGetLot(auctionId, lotId);
    if (!lot) throw new AuctionLotNotFoundError();

    const res = await db.execute<{
      bidder_id: number;
      bidder_name: string | null;
      user_id: number | null;
      login_id: string | null;
      is_logged_in: boolean;
      tnc_accepted: boolean;
    }>(sql`
      SELECT *
      FROM (
        SELECT DISTINCT ON (b.bidder_id)
          b.bidder_id,
          bd.company_name AS bidder_name,
          u.id AS user_id,
          u.user_login_name AS login_id,
          COALESCE(u.is_login, false) AS is_logged_in,
          EXISTS (
            SELECT 1 FROM auction_tnc_acceptances t
            WHERE t.auction_id = ${auctionId} AND t.bidder_id = b.bidder_id
          ) AS tnc_accepted
        FROM auction_bids b
        LEFT JOIN bidders bd ON bd.id = b.bidder_id
        LEFT JOIN users u ON u.bidder_id = b.bidder_id
        WHERE b.lot_id = ${lotId} AND b.auction_id = ${auctionId}
        ORDER BY b.bidder_id, u.id NULLS LAST
      ) x
      ORDER BY x.bidder_name NULLS LAST, x.bidder_id
    `);

    const rows = res.rows.map((r) => ({
      bidderId: r.bidder_id,
      companyName: r.bidder_name,
      userId: r.user_id != null ? Number(r.user_id) : null,
      loginId: r.login_id,
      isLoggedIn: r.is_logged_in === true,
      tncAccepted: r.tnc_accepted === true,
    }));

    const [auction] = await db
      .select({
        auctionType: auctions.auctionType,
        isRankBased: auctions.isRankBased,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    if (auction?.isRankBased !== true) {
      return rows.map((r) => ({ ...r, rank: null }));
    }
    // Rank-based: order by the bidder's live rank instead of name.
    const rankings = await loadRankings(
      db,
      sql`lot_id = ${lotId} AND auction_id = ${auctionId}`,
      bidDirectionFor(auction.auctionType),
    );
    return withBidderRanks(rows, rankings);
  }

  async patchLot(
    auctionId: number,
    lotId: number,
    body: CreateLotBody,
    userId: number,
  ) {
    const lot = await pgGetLot(auctionId, lotId);
    if (!lot) throw new AuctionLotNotFoundError();
    await this.assertEditableForLotWrites(auctionId, lot.isReopened);
    await this.assertLotWriteCrossFields(auctionId, body);
    try {
      await pgPatchLot(auctionId, lotId, body, userId);
    } catch (err) {
      if (err instanceof Error) {
        throw new AuctionValidationError(err.message);
      }
      throw err;
    }
  }

  async lotEditorOptions(auctionId: number) {
    await this.assertExists(auctionId);
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();
    const { items: _items, ...rest } = await pgListLotEditorOptions(clientId);
    return rest;
  }

  async listActiveOptions(
    opts: {
      q?: string;
      limit?: number;
      ids?: number[];
      clientId?: number;
    } = {},
  ): Promise<
    Array<{
      auctionId: number;
      auctionNumber: string | null;
      clientId: number | null;
      clientName: string | null;
      label: string;
    }>
  > {
    const q = opts.q?.trim() ?? "";
    const ids = opts.ids ?? [];
    const limit = resolveOptionsLimit(q, opts.limit);

    const selectShape = {
      id: auctions.id,
      auctionNumber: auctions.auctionNumber,
      clientId: auctions.clientId,
      clientName: clients.companyName,
    };

    const baseConditions: SQL[] = [ne(auctions.status, "archived")];
    if (opts.clientId != null) {
      baseConditions.push(eq(auctions.clientId, opts.clientId));
    }

    const byIds =
      ids.length > 0
        ? await db
            .select(selectShape)
            .from(auctions)
            .leftJoin(clients, eq(clients.id, auctions.clientId))
            .where(
              and(
                inArray(auctions.id, ids),
                ...(opts.clientId != null
                  ? [eq(auctions.clientId, opts.clientId)]
                  : []),
              ),
            )
            .orderBy(desc(auctions.auctionDate))
        : [];

    const searchConditions: SQL[] = [...baseConditions];
    if (q) {
      const pattern = `%${q}%`;
      searchConditions.push(
        or(
          ilike(auctions.auctionNumber, pattern),
          ilike(clients.companyName, pattern),
          ilike(sql`cast(${auctions.id} as text)`, pattern),
        )!,
      );
    }

    const searchQuery = db
      .select(selectShape)
      .from(auctions)
      .leftJoin(clients, eq(clients.id, auctions.clientId))
      .where(and(...searchConditions))
      .orderBy(desc(auctions.auctionDate));

    const searched =
      limit != null ? await searchQuery.limit(limit) : await searchQuery;

    const map = new Map<number, (typeof searched)[number]>();
    for (const row of byIds) map.set(row.id, row);
    for (const row of searched) {
      if (!map.has(row.id)) map.set(row.id, row);
    }
    const merged = [...map.values()];
    const idSet = new Set(byIds.map((r) => r.id));
    const kept: typeof merged =
      limit == null
        ? merged
        : (() => {
            const next = merged.filter((r) => idSet.has(r.id));
            for (const row of merged) {
              if (next.length >= Math.max(limit, idSet.size)) break;
              if (!idSet.has(row.id)) next.push(row);
            }
            return next;
          })();

    return kept.map((r) => {
      const auctionNumber = r.auctionNumber ?? `#${r.id}`;
      const clientName = r.clientName ?? "";
      return {
        auctionId: r.id,
        auctionNumber: r.auctionNumber ?? null,
        clientId: r.clientId,
        clientName: r.clientName ?? null,
        label: clientName ? `${auctionNumber} — ${clientName}` : auctionNumber,
      };
    });
  }

  async listActiveOptionIds(
    opts: {
      q?: string;
      clientId?: number;
    } = {},
  ): Promise<EntityOptionIdsResult> {
    const q = opts.q?.trim() ?? "";
    const baseConditions: SQL[] = [ne(auctions.status, "archived")];
    if (opts.clientId != null) {
      baseConditions.push(eq(auctions.clientId, opts.clientId));
    }
    if (q) {
      const pattern = `%${q}%`;
      baseConditions.push(
        or(
          ilike(auctions.auctionNumber, pattern),
          ilike(clients.companyName, pattern),
          ilike(sql`cast(${auctions.id} as text)`, pattern),
        )!,
      );
    }
    const searchWhere = and(...baseConditions);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(auctions)
      .leftJoin(clients, eq(clients.id, auctions.clientId))
      .where(searchWhere);

    const total = countRow?.total ?? 0;
    const rows = await db
      .select({ id: auctions.id })
      .from(auctions)
      .leftJoin(clients, eq(clients.id, auctions.clientId))
      .where(searchWhere)
      .orderBy(desc(auctions.auctionDate))
      .limit(MAX_SELECT_ALL_IDS);

    return toOptionIdsResult(
      rows.map((r) => r.id),
      total,
    );
  }

  async lotBidderSummary(auctionId: number) {
    await this.assertExists(auctionId);
    const lots = await pgLotBidderSummary(auctionId);
    return { lots };
  }

  async lotBidderMap(
    auctionId: number,
    opts: AuctionLotBidderMapListParams = {},
  ) {
    await this.assertExists(auctionId);
    return pgLotBidderMapPaginated(auctionId, opts);
  }

  /**
   * Every active bidder-lot attachment, grouped by (bidder, isEmdWithClient)
   * into one row per group — the shape the import template expects, so the
   * export can be re-imported as-is (e.g. to re-attach after a reopen).
   * Bidders whose EMD was released as a non-winner stay `isActive` and are
   * included the same as everyone else; no special-casing needed.
   */
  async lotBidderMapExportRows(
    auctionId: number,
  ): Promise<LotBidderMapExportRow[]> {
    await this.assertExists(auctionId);
    const [mapRows, rangeRows] = await Promise.all([
      pgLotBidderMapForExport(auctionId),
      pgEmdRanges(auctionId),
    ]);
    const ranges = rangeRows.map((r) => ({
      lotDisplayOrderFrom: r.lotDisplayOrderFrom,
      lotDisplayOrderTo: r.lotDisplayOrderTo,
      displayOrder: r.displayOrder,
    }));

    const groups = new Map<
      string,
      {
        bidderId: number;
        bidderName: string;
        isEmdWithClient: boolean;
        lotDisplayOrders: Set<number>;
      }
    >();

    for (const row of mapRows) {
      const key = `${row.bidderId}|${row.isEmdWithClient}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          bidderId: row.bidderId,
          bidderName: row.bidderName,
          isEmdWithClient: row.isEmdWithClient,
          lotDisplayOrders: new Set(),
        };
        groups.set(key, group);
      }
      group.lotDisplayOrders.add(row.displayOrder);
    }

    return Array.from(groups.values())
      .sort(
        (a, b) =>
          a.bidderName.localeCompare(b.bidderName) ||
          Number(a.isEmdWithClient) - Number(b.isEmdWithClient),
      )
      .map((g) => {
        const lotDisplayOrders = Array.from(g.lotDisplayOrders).sort(
          (a, b) => a - b,
        );
        const emdDisplayOrders = new Set<number>();
        for (const order of lotDisplayOrders) {
          const range = ranges.find((r) =>
            isLotDisplayOrderCoveredByRange(order, r),
          );
          if (range?.displayOrder != null) {
            emdDisplayOrders.add(range.displayOrder);
          }
        }
        return {
          bidderId: g.bidderId,
          bidderName: g.bidderName,
          lotDisplayOrders,
          emdDisplayOrders: Array.from(emdDisplayOrders).sort((a, b) => a - b),
          isEmdWithClient: g.isEmdWithClient,
        };
      });
  }

  async bidderPool(auctionId: number) {
    await this.assertExists(auctionId);
    const biddersList = await pgBidderPool(auctionId);
    return { bidders: biddersList };
  }

  async removeBidderPoolEntry(auctionId: number, mapId: number) {
    await this.assertDraftForLotWrites(auctionId);
    await pgRemoveBidderPoolEntry(auctionId, mapId);
  }

  /**
   * Load the auction-level inputs the Attach Bidders flow needs to compute EMD
   * requirements: every lot (with display order), the EMD display-order ranges,
   * and the consolidated EMD ceiling. Fetched once and reused across rows.
   */
  private async loadEmdInputs(auctionId: number) {
    const [allLots, withdrawnDisplayOrderKeys] = await Promise.all([
      pgListLots(auctionId),
      pgLoadWithdrawnDisplayOrderKeys(auctionId),
    ]);
    // Defense in depth: EMD / bidder mapping never includes withdrawn lots.
    const activeLots = allLots.filter((l) => l.isActive !== false);
    const ranges = (await pgEmdRanges(auctionId)).map((r) => ({
      lotDisplayOrderFrom: r.lotDisplayOrderFrom,
      lotDisplayOrderTo: r.lotDisplayOrderTo,
      emdAmount: r.emd,
      displayOrder: r.displayOrder,
    }));
    const { consolidatedEmd } = await this.getAuctionEmd(auctionId);
    const lotById = new Map(activeLots.map((l) => [l.lotId, l] as const));
    const lotByDisplayOrder = new Map(
      activeLots
        .filter((l) => l.displayOrder != null)
        .map((l) => [l.displayOrder as number, l] as const),
    );
    return {
      allLots: activeLots,
      lotById,
      lotByDisplayOrder,
      withdrawnDisplayOrderKeys,
      ranges,
      consolidatedEmd,
    };
  }

  /** EMD required + covered display-order range for a specific set of lots. */
  private computeCtxForLots(
    inputs: Awaited<ReturnType<AuctionsService["loadEmdInputs"]>>,
    lotIds: number[],
  ) {
    const selectedLots = lotIds
      .map((id) => inputs.lotById.get(id))
      .filter((l): l is (typeof inputs.allLots)[number] => l != null);

    const { emdRequired } = computeBidderEmdRequired({
      selectedLots: selectedLots.map((l) => ({
        lotId: l.lotId,
        displayOrder: l.displayOrder,
      })),
      ranges: inputs.ranges,
      consolidatedEmd: inputs.consolidatedEmd,
    });

    const orders = selectedLots
      .map((l) => l.displayOrder)
      .filter((o): o is number => o != null)
      .sort((a, b) => a - b);

    return {
      emdRequired,
      lotDisplayOrders: orders,
      lotDisplayOrderFrom: orders.length ? orders[0]! : null,
      lotDisplayOrderTo: orders.length ? orders[orders.length - 1]! : null,
      validLotIds: selectedLots.map((l) => l.lotId),
    };
  }

  private formatUnmappedLotsError(
    inputs: Awaited<ReturnType<AuctionsService["loadEmdInputs"]>>,
    badLotIds: number[],
  ): string {
    const orders = badLotIds
      .map((id) => inputs.lotById.get(id)?.displayOrder)
      .filter((o): o is number => o != null)
      .sort((a, b) => a - b);
    if (orders.length > 0) {
      return AuctionsValidationMessages.LOT_OUTSIDE_EMD_RANGE_ORDERS(
        orders.join(", "),
      );
    }
    return AuctionsValidationMessages.LOT_OUTSIDE_EMD_RANGE;
  }

  private assertNoUnmappedLotsSelected(
    inputs: Awaited<ReturnType<AuctionsService["loadEmdInputs"]>>,
    lotIds: number[],
  ): void {
    const bad = unmappedSelectedLotIds(
      inputs.allLots.map((l) => ({
        lotId: l.lotId,
        lotNumber: l.lotNumber,
        displayOrder: l.displayOrder,
      })),
      inputs.ranges.map((r) => ({
        lotDisplayOrderFrom: r.lotDisplayOrderFrom,
        lotDisplayOrderTo: r.lotDisplayOrderTo,
      })),
      lotIds,
    );
    if (bad.length === 0) return;
    throw new AuctionValidationError(
      this.formatUnmappedLotsError(inputs, bad),
    );
  }

  async lotBidderMapPreview(
    auctionId: number,
    bidderIds: number[],
    lotIds: number[],
  ): Promise<{ rows: LotBidderMapPreviewRow[] }> {
    await this.assertPublishedForBidderWrites(auctionId);
    await this.assertEmdSetForBidderWrites(auctionId);
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();

    const inputs = await this.loadEmdInputs(auctionId);
    this.assertNoUnmappedLotsSelected(inputs, lotIds);
    const ctx = this.computeCtxForLots(inputs, lotIds);
    const wallets = await pgBidderEmdWallets(bidderIds);
    const walletById = new Map(wallets.map((w) => [w.bidderId, w] as const));
    const blockedIds = await blockedBidderIdsForClient(clientId, bidderIds);

    // Each bidder's existing block and wallet-blocked lots: the block submitted
    // is the combined requirement (existing + newly selected lots), not
    // `ctx.emdRequired` for the new lots alone.
    const alreadyBlockedByBidder = await emdBlocksService.alreadyBlockedForBidders(bidderIds, auctionId);
    // Lots in a range the bidder already holds EMD for (a reopened auction) add
    // nothing to the block, so they are left out of every requirement below.
    const heldLotIdsByBidder = new Map<number, Set<number>>(
      await Promise.all(
        bidderIds.map(
          async (bidderId) =>
            [bidderId, await pgHeldCoveredLotIds(db, auctionId, bidderId)] as const,
        ),
      ),
    );
    const mappedLotIdsByBidder = new Map<number, number[]>(
      await Promise.all(
        bidderIds.map(
          async (bidderId) =>
            [
              bidderId,
              (await pgActiveMappedLotsTx(db, auctionId, bidderId))
                .filter(
                  (l) =>
                    !l.isEmdWithClient &&
                    !l.emdReleased &&
                    !heldLotIdsByBidder.get(bidderId)?.has(l.lotId),
                )
                .map((l) => l.lotId),
            ] as const,
        ),
      ),
    );

    const rows: LotBidderMapPreviewRow[] = bidderIds.map((bidderId) => {
      const wallet = walletById.get(bidderId);
      let error: string | null = null;
      if (!wallet) {
        error = AuctionsValidationMessages.BIDDER_NOT_FOUND;
      } else if (wallet.isVerified === false) {
        error = AuctionsValidationMessages.BIDDER_NOT_VERIFIED_FOR_ATTACH;
      } else if (blockedIds.has(bidderId)) {
        error = AuctionsValidationMessages.BIDDER_BLOCKED_FOR_CLIENT_ATTACH;
      }
      const alreadyBlockedInfo = alreadyBlockedByBidder.get(bidderId) ?? { amount: 0, status: null };
      const mappedLotIds = mappedLotIdsByBidder.get(bidderId) ?? [];
      const heldLotIds = heldLotIdsByBidder.get(bidderId);
      const liveLotIds = ctx.validLotIds.filter((id) => !heldLotIds?.has(id));
      const liveCtx = this.computeCtxForLots(inputs, liveLotIds);
      const combinedCtx = this.computeCtxForLots(inputs, [
        ...new Set([...mappedLotIds, ...liveLotIds]),
      ]);
      return {
        bidderId,
        bidderName: wallet?.companyName ?? `Bidder #${bidderId}`,
        lotIds: ctx.validLotIds,
        lotDisplayOrders: ctx.lotDisplayOrders,
        lotDisplayOrderFrom: ctx.lotDisplayOrderFrom,
        lotDisplayOrderTo: ctx.lotDisplayOrderTo,
        emdRequired: liveCtx.emdRequired,
        alreadyBlocked: alreadyBlockedInfo.amount,
        combinedEmdRequired: combinedCtx.emdRequired,
        emdAvailable: wallet?.emdAvailable ?? 0,
        isEmdWithClient: false,
        emdAmount: Math.max(
          0,
          combinedCtx.emdRequired - alreadyBlockedInfo.amount,
        ),
        error,
      };
    });

    return { rows };
  }

  async submitLotBidderMap(
    auctionId: number,
    input: { rows: LotBidderMapSubmitRow[] },
    userId: number,
  ): Promise<{
    mapped: number;
    skipped: number;
    results: Array<{
      bidderId: number;
      status: "mapped" | "skipped" | "error";
      error: string | null;
      message: string | null;
    }>;
  }> {
    await this.assertPublishedForBidderWrites(auctionId);
    await this.assertEmdSetForBidderWrites(auctionId);
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();

    const inputs = await this.loadEmdInputs(auctionId);
    const coverageLots = inputs.allLots.map((l) => ({
      lotId: l.lotId,
      lotNumber: l.lotNumber,
      displayOrder: l.displayOrder,
    }));
    const rangeBounds = inputs.ranges.map((r) => ({
      lotDisplayOrderFrom: r.lotDisplayOrderFrom,
      lotDisplayOrderTo: r.lotDisplayOrderTo,
    }));
    const wallets = await pgBidderEmdWallets(input.rows.map((r) => r.bidderId));
    const walletById = new Map(wallets.map((w) => [w.bidderId, w] as const));
    const blockedIds = await blockedBidderIdsForClient(
      clientId,
      input.rows.map((r) => r.bidderId),
    );

    const results: Array<{
      bidderId: number;
      status: "mapped" | "skipped" | "error";
      error: string | null;
      message: string | null;
    }> = [];
    for (const row of input.rows) {
      const wallet = walletById.get(row.bidderId);
      if (!wallet) {
        results.push({
          bidderId: row.bidderId,
          status: "error",
          error: AuctionsValidationMessages.BIDDER_NOT_FOUND,
          message: null,
        });
        continue;
      }
      if (wallet.isVerified === false) {
        results.push({
          bidderId: row.bidderId,
          status: "error",
          error: AuctionsValidationMessages.BIDDER_NOT_VERIFIED_FOR_ATTACH,
          message: null,
        });
        continue;
      }
      if (blockedIds.has(row.bidderId)) {
        results.push({
          bidderId: row.bidderId,
          status: "error",
          error: AuctionsValidationMessages.BIDDER_BLOCKED_FOR_CLIENT_ATTACH,
          message: null,
        });
        continue;
      }

      const unmappedSelected = unmappedSelectedLotIds(
        coverageLots,
        rangeBounds,
        row.lotIds,
      );
      if (unmappedSelected.length > 0) {
        results.push({
          bidderId: row.bidderId,
          status: "error",
          error: this.formatUnmappedLotsError(inputs, unmappedSelected),
          message: null,
        });
        continue;
      }

      const ctx = this.computeCtxForLots(inputs, row.lotIds);
      if (ctx.validLotIds.length === 0) {
        results.push({
          bidderId: row.bidderId,
          status: "error",
          error: AuctionsValidationMessages.NO_VALID_LOTS_FOR_BIDDER,
          message: null,
        });
        continue;
      }

      const existingFlagByLot = await pgActiveMappedLotFlags(
        auctionId,
        row.bidderId,
        ctx.validLotIds,
      );
      const newLotIds = ctx.validLotIds.filter((id) => !existingFlagByLot.has(id));
      const flagChangedLotIds = ctx.validLotIds.filter(
        (id) =>
          existingFlagByLot.has(id) &&
          existingFlagByLot.get(id) !== row.isEmdWithClient,
      );
      // Already attached to every selected lot with the same flag is a no-op,
      // except for a bidder whose EMD was released at an earlier close:
      // re-attaching re-blocks it.
      const needsReblock =
        newLotIds.length === 0 &&
        flagChangedLotIds.length === 0 &&
        (await pgReleasedMappedLotIds(auctionId, row.bidderId, ctx.validLotIds)).size > 0;
      if (newLotIds.length === 0 && flagChangedLotIds.length === 0 && !needsReblock) {
        results.push({
          bidderId: row.bidderId,
          status: "skipped",
          error: null,
          message:
            AuctionsValidationMessages.BIDDER_ALREADY_ATTACHED_TO_SELECTED_LOTS,
        });
        continue;
      }

      // The block is always Full and covers the lots whose EMD is not with the
      // client, across the bidder's whole lot set on this auction: EMD is
      // charged per covering range, so a lot inside an already-paid-for range
      // adds nothing while one in a new range adds that range's amount.
      // A lot in a range the bidder already holds EMD for (a reopened auction)
      // adds nothing: that EMD is already blocked.
      const heldLotIds = await pgHeldCoveredLotIds(db, auctionId, row.bidderId);
      const requestedLotIds = new Set(ctx.validLotIds);
      const mappedLots = await pgActiveMappedLotsTx(db, auctionId, row.bidderId);
      const walletLotIds = [
        ...mappedLots
          .filter(
            (l) =>
              !l.isEmdWithClient &&
              !l.emdReleased &&
              !requestedLotIds.has(l.lotId) &&
              !heldLotIds.has(l.lotId),
          )
          .map((l) => l.lotId),
        ...(row.isEmdWithClient ? [] : ctx.validLotIds.filter((id) => !heldLotIds.has(id))),
      ];
      const totalCtx = this.computeCtxForLots(inputs, walletLotIds);
      const targetBlockAmount = totalCtx.emdRequired;

      // Available excludes the bidder's already-blocked amount, which this
      // attach replaces, so only the net increase has to be covered.
      const alreadyBlocked =
        (await emdBlocksService.alreadyBlockedForBidders([row.bidderId], auctionId)).get(
          row.bidderId,
        )?.amount ?? 0;
      const error = validateBlockRow({
        isEmdWithClient: row.isEmdWithClient,
        emdRequired: targetBlockAmount,
        emdAvailable: wallet.emdAvailable + alreadyBlocked,
      });
      if (error) {
        results.push({
          bidderId: row.bidderId,
          status: "error",
          error,
          message: null,
        });
        continue;
      }

      let attachResult: Awaited<ReturnType<typeof pgAttachBidderToLots>>;
      try {
        attachResult = await pgAttachBidderToLots(
          auctionId,
          clientId,
          row.bidderId,
          ctx.validLotIds,
          row.isEmdWithClient,
          userId,
          { targetBlockAmount },
        );
      } catch (err) {
        if (!(err instanceof EmdError)) throw err;
        results.push({
          bidderId: row.bidderId,
          status: "error",
          error: err.message,
          message: null,
        });
        continue;
      }

      if (attachResult.reblocked) {
        results.push({
          bidderId: row.bidderId,
          status: "mapped",
          error: null,
          message: null,
        });
        continue;
      }

      const updatedLotCount = attachResult.updatedLotIds?.length ?? 0;
      if (attachResult.attachedLotIds.length === 0 && updatedLotCount === 0) {
        results.push({
          bidderId: row.bidderId,
          status: "skipped",
          error: null,
          message:
            AuctionsValidationMessages.BIDDER_ALREADY_ATTACHED_TO_SELECTED_LOTS,
        });
        continue;
      }

      const skippedLots = attachResult.skippedLotIds.length;
      results.push({
        bidderId: row.bidderId,
        status: "mapped",
        error: null,
        message:
          skippedLots > 0
            ? AuctionsValidationMessages.BIDDER_ATTACHED_WITH_SKIPPED(
                attachResult.attachedLotIds.length + updatedLotCount,
                skippedLots,
              )
            : null,
      });
    }

    return {
      mapped: results.filter((r) => r.status === "mapped").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
    };
  }

  async removeLotBidderMap(
    auctionId: number,
    input: { bidderIds: number[]; lotIds: number[] },
    userId: number,
  ): Promise<{ removed: number; requestedPairs: number }> {
    await this.assertPublishedForBidderWrites(auctionId);

    const normalized = normalizeLotBidderRemoveSelection(
      input.bidderIds,
      input.lotIds,
    );
    if (!normalized) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.SELECT_LOT_AND_BIDDER,
      );
    }

    const inputs = await this.loadEmdInputs(auctionId);

    // Detach and the EMD it frees must commit together, or a failure here would
    // leave lots detached with their EMD still blocked and no path to recover it.
    const { removed } = await emdTransactionsService.run(async (tx) => {
      // Snapshot each bidder's wallet-blocked lots before detaching, so a full
      // release can record exactly which lots it released.
      const beforeLotIdsByBidder = new Map<number, number[]>(
        await Promise.all(
          normalized.bidderIds.map(
            async (bidderId) =>
              [bidderId, await pgActiveWalletLotIdsTx(tx, auctionId, bidderId)] as const,
          ),
        ),
      );

      const result = await pgDetachBiddersFromLots(
        auctionId,
        normalized.bidderIds,
        normalized.lotIds,
        userId,
        tx,
      );
      if (result.removed === 0) return result;

      for (const bidderId of normalized.bidderIds) {
        // Only lots whose EMD is not with the client carry a wallet block, so
        // the block is released once none of those remain — even if EMD-with-
        // client lots are still attached.
        const remainingLotIds = await pgActiveWalletLotIdsTx(tx, auctionId, bidderId);
        if (remainingLotIds.length === 0) {
          await emdBlocksService.releaseFullBlock(tx, {
            auctionId,
            bidderId,
            emdType: "release_bidder_detached",
            lotIds: beforeLotIdsByBidder.get(bidderId) ?? null,
            userId,
          });
          continue;
        }
        // Recompute over what is left. Clamped to the already-blocked amount
        // so a detach can only lower it — an older partial or exception
        // block stays under-funded rather than being topped up here.
        const alreadyBlocked = await emdBlocksService.blockedOnAuction(tx, bidderId, auctionId);
        if (alreadyBlocked <= 0) continue;
        const { emdRequired } = this.computeCtxForLots(inputs, remainingLotIds);
        await emdBlocksService.reconcileBlock(tx, {
          auctionId,
          bidderId,
          targetAmount: Math.min(alreadyBlocked, emdRequired),
          lotIds: remainingLotIds,
          userId,
        });
      }
      return result;
    });

    return {
      removed,
      requestedPairs: normalized.requestedPairs,
    };
  }

  /**
   * Parse and validate a bulk lot bidder map .xlsx into review rows. Each row is
   * fully validated (bidder match, lot/EMD display-order sync, EMD block rules
   * and wallet coverage) so the UI can show per-row errors before submit.
   */
  async importLotBidderMap(
    auctionId: number,
    buffer: Buffer,
  ): Promise<{
    rows: LotBidderMapPreviewRow[];
    skipped: Array<{ rowNumber: number; reason: string }>;
  }> {
    await this.assertPublishedForBidderWrites(auctionId);
    await this.assertEmdSetForBidderWrites(auctionId);
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();

    const inputs = await this.loadEmdInputs(auctionId);
    const coverageLots = inputs.allLots.map((l) => ({
      lotId: l.lotId,
      lotNumber: l.lotNumber,
      displayOrder: l.displayOrder,
    }));
    const rangeBounds = inputs.ranges.map((r) => ({
      lotDisplayOrderFrom: r.lotDisplayOrderFrom,
      lotDisplayOrderTo: r.lotDisplayOrderTo,
    }));

    const parsed = await parseLotBidderMapImportXlsxBuffer(buffer);
    if (parsed.headerError) {
      throw new AuctionValidationError(parsed.headerError);
    }
    const { rows: rawRows, skipped: dedupedSkipped } =
      dedupeLotBidderMapImportRows(parsed.rows);
    const skipped = dedupedSkipped.map((s) => ({
      rowNumber: s.rowNumber,
      reason: AuctionsValidationMessages.DUPLICATE_OF_ROW(s.keptRowNumber),
    }));
    const bidderIds = rawRows
      .map((r) => r.bidderId)
      .filter((id): id is number => id != null);
    const wallets = await pgBidderEmdWallets(bidderIds);
    const walletById = new Map(wallets.map((w) => [w.bidderId, w] as const));
    const blockedIds = await blockedBidderIdsForClient(clientId, bidderIds);

    const rows: LotBidderMapPreviewRow[] = rawRows.map((raw) => {
      const errors: string[] = [];

      // Bidder id + name match (both mandatory).
      const wallet =
        raw.bidderId != null ? walletById.get(raw.bidderId) : undefined;
      if (raw.bidderId == null) {
        errors.push(AuctionsValidationMessages.LOT_BIDDER_MAP_BIDDER_ID_REQUIRED);
      } else if (!wallet) {
        errors.push(AuctionsValidationMessages.BIDDER_NOT_FOUND);
      } else if (wallet.isVerified === false) {
        errors.push(AuctionsValidationMessages.BIDDER_NOT_VERIFIED_FOR_ATTACH);
      } else if (blockedIds.has(raw.bidderId)) {
        errors.push(
          AuctionsValidationMessages.BIDDER_BLOCKED_FOR_CLIENT_ATTACH,
        );
      }
      if (raw.bidderName.trim() === "") {
        errors.push(AuctionsValidationMessages.LOT_BIDDER_MAP_BIDDER_NAME_REQUIRED);
      } else if (
        wallet &&
        raw.bidderName.trim().toLowerCase() !==
          wallet.companyName.trim().toLowerCase()
      ) {
        errors.push(
          AuctionsValidationMessages.LOT_BIDDER_MAP_BIDDER_ID_NAME_MISMATCH,
        );
      }

      // EMD display orders are always required.
      let resolvedEmdRanges: ReturnType<
        typeof resolveEmdRangesByDisplayOrders
      >["ranges"] = [];
      if (raw.emdDisplayOrders.length === 0) {
        errors.push(
          AuctionsValidationMessages.LOT_BIDDER_MAP_EMD_DISPLAY_ORDERS_REQUIRED,
        );
      } else {
        const resolved = resolveEmdRangesByDisplayOrders(
          raw.emdDisplayOrders,
          inputs.ranges,
        );
        if (resolved.missingOrders.length > 0) {
          errors.push(
            AuctionsValidationMessages.LOT_BIDDER_MAP_EMD_DISPLAY_ORDER_NOT_FOUND(
              resolved.missingOrders.join(", "),
            ),
          );
        }
        resolvedEmdRanges = resolved.ranges;
      }

      // Lots: explicit list, or expand from EMD ranges when blank.
      const lotIds: number[] = [];
      const missingOrders: number[] = [];

      if (raw.lotDisplayOrders.length > 0) {
        const withdrawnOrders: number[] = [];
        for (const order of raw.lotDisplayOrders) {
          const lot = inputs.lotByDisplayOrder.get(order);
          if (lot) {
            lotIds.push(lot.lotId);
            continue;
          }
          const orderKey = normalizeDisplayOrderKey(order);
          if (inputs.withdrawnDisplayOrderKeys.has(orderKey)) {
            withdrawnOrders.push(order);
          } else {
            missingOrders.push(order);
          }
        }
        if (withdrawnOrders.length > 0) {
          errors.push(
            AuctionsValidationMessages.LOT_DISPLAY_ORDER_WITHDRAWN(
              withdrawnOrders.join(", "),
            ),
          );
        }
        if (missingOrders.length > 0) {
          errors.push(
            AuctionsValidationMessages.LOT_DISPLAY_ORDER_NOT_FOUND(
              missingOrders.join(", "),
            ),
          );
        }
        if (resolvedEmdRanges.length > 0 && missingOrders.length === 0) {
          const sync = assertLotEmdDisplayOrdersInSync({
            lotOrders: raw.lotDisplayOrders,
            emdRanges: resolvedEmdRanges,
          });
          if (!sync.ok) errors.push(...sync.errors);
        }
      } else if (resolvedEmdRanges.length > 0) {
        const expanded = expandLotsFromEmdRanges({
          allLots: inputs.allLots.map((l) => ({
            lotId: l.lotId,
            displayOrder: l.displayOrder,
          })),
          emdRanges: resolvedEmdRanges,
        });
        lotIds.push(...expanded);
        if (expanded.length === 0) {
          errors.push(
            AuctionsValidationMessages.LOT_BIDDER_MAP_EMD_DISPLAY_ORDERS_COVER_NO_LOTS,
          );
        }
      }

      const unmappedSelected = unmappedSelectedLotIds(
        coverageLots,
        rangeBounds,
        lotIds,
      );
      if (unmappedSelected.length > 0) {
        errors.push(this.formatUnmappedLotsError(inputs, unmappedSelected));
      }

      const { emdRequired } = computeBidderEmdRequiredFromEmdDisplayOrders({
        ranges: resolvedEmdRanges,
        consolidatedEmd: inputs.consolidatedEmd,
      });

      const orders = lotIds
        .map((id) => inputs.lotById.get(id)?.displayOrder)
        .filter((o): o is number => o != null)
        .sort((a, b) => a - b);
      const lotDisplayOrderFrom = orders.length ? orders[0]! : null;
      const lotDisplayOrderTo = orders.length
        ? orders[orders.length - 1]!
        : null;

      // EMD with client; otherwise the full requirement is blocked.
      const isEmdWithClient = parseIsEmdWithClient(raw.isEmdWithClientRaw);
      if (isEmdWithClient == null) {
        errors.push(
          AuctionsValidationMessages.LOT_BIDDER_MAP_IS_EMD_WITH_CLIENT_INVALID,
        );
      }
      const emdAvailable = wallet?.emdAvailable ?? 0;

      if (errors.length === 0 && isEmdWithClient != null) {
        const blockError = validateBlockRow({
          isEmdWithClient,
          emdRequired,
          emdAvailable,
        });
        if (blockError) errors.push(blockError);
      }

      return {
        bidderId: raw.bidderId ?? 0,
        bidderName:
          wallet?.companyName ?? (raw.bidderName || `Row ${raw.rowNumber}`),
        lotIds,
        lotDisplayOrders: orders,
        lotDisplayOrderFrom,
        lotDisplayOrderTo,
        emdRequired,
        emdAvailable,
        isEmdWithClient: isEmdWithClient ?? false,
        emdAmount: isEmdWithClient === true ? null : emdRequired,
        error: errors.length > 0 ? errors.join("; ") : null,
        rowNumber: raw.rowNumber,
      };
    });

    return { rows, skipped };
  }

  async emdRanges(auctionId: number) {
    const row = await this.getAuctionEmd(auctionId);
    const ranges = await pgEmdRanges(auctionId);
    return {
      ranges,
      consolidatedEmd: row.consolidatedEmd,
    };
  }

  async addEmdRange(
    auctionId: number,
    body: {
      lotDisplayOrderFrom: number;
      lotDisplayOrderTo: number;
      emd: number;
    },
    userId: number,
  ) {
    await this.assertPublishedForEmdWrites(auctionId);
    await pgInsertEmdRange(auctionId, body, userId);
  }

  async deleteEmdRange(auctionId: number, lotEmdId: number) {
    await this.assertPublishedForEmdWrites(auctionId);
    const ranges = await pgEmdRanges(auctionId);
    const rangesAfter = ranges.filter((r) => r.lotEmdId !== lotEmdId);
    await this.assertRangeEditableForAttachedBidders(
      auctionId,
      ranges,
      rangesAfter,
    );
    await pgDeleteEmdRange(auctionId, lotEmdId);
  }

  /**
   * Blocks touching a range — removing it, shrinking it, or changing its
   * amount — while a bidder is attached to a lot it covers: that lot's
   * covering amount before and after must match, and it must still be
   * covered by something. Ranges with no attached bidders stay freely
   * editable. Adding a new range is never affected — it never changes an
   * existing lot's covering amount.
   */
  private async assertRangeEditableForAttachedBidders(
    auctionId: number,
    rangesBefore: Array<{
      lotDisplayOrderFrom: number;
      lotDisplayOrderTo: number;
      emd: number;
    }>,
    rangesAfter: Array<{
      lotDisplayOrderFrom: number;
      lotDisplayOrderTo: number;
      emd: number;
    }>,
  ) {
    const attachedLots = await pgLotsWithAttachedBidders(auctionId);
    const blocked = attachedLots.some((lot) => {
      if (lot.displayOrder == null) return false;
      const before = rangesBefore.find((r) =>
        isLotDisplayOrderCoveredByRange(lot.displayOrder!, r),
      );
      const after = rangesAfter.find((r) =>
        isLotDisplayOrderCoveredByRange(lot.displayOrder!, r),
      );
      if (!after) return true;
      if (!before) return false;
      return before.emd !== after.emd;
    });
    if (blocked) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.EMD_RANGE_LOCKED_AFTER_BIDDERS_ATTACHED,
      );
    }
  }

  async replaceEmdRanges(
    auctionId: number,
    body: {
      consolidatedEmd: number;
      ranges: Array<{
        displayOrder?: number | null;
        lotDisplayOrderFrom: number;
        lotDisplayOrderTo: number;
        emd: number;
      }>;
    },
    userId: number,
  ) {
    await this.assertPublishedForEmdWrites(auctionId);
    const rangesBefore = await pgEmdRanges(auctionId);
    await this.assertRangeEditableForAttachedBidders(
      auctionId,
      rangesBefore,
      body.ranges,
    );
    try {
      return await pgReplaceEmdRanges(
        auctionId,
        body.consolidatedEmd,
        body.ranges,
        userId,
      );
    } catch (err) {
      if (err instanceof Error) {
        throw new AuctionValidationError(err.message);
      }
      throw err;
    }
  }

  async listDocumentTypes() {
    return pgListAuctionDocumentTypes();
  }

  /**
   * Today's published auctions for the admin dashboard. Status is live or
   * upcoming from the lot schedule (IST): upcoming before the earliest lot
   * start, live once started and not yet ended. Closed auctions are omitted.
   * Catalogue / T&C are signed R2 download URLs.
   */
  async todaysAuctions() {
    return this.scheduledAuctions({ when: "today" });
  }

  /** Published today auctions for companies linked to this portal user. */
  async portalTodaysAuctions(userId: number) {
    return this.scheduledAuctions({ when: "today", userId });
  }

  /** Published auctions after today (IST) for companies linked to this portal user. */
  async portalFutureAuctions(userId: number) {
    return this.scheduledAuctions({ when: "future", userId });
  }

  /** Closed auctions for companies linked to this portal user. */
  async portalClosedAuctions(
    userId: number,
    range?: { from: string; to: string },
  ) {
    const clientClause = sql`AND a.client_id IN (
      SELECT uc.client_id FROM user_clients uc
      WHERE uc.user_id = ${userId} AND uc.is_active = true
    )`;
    const dateClause = range
      ? sql`AND a.auction_date::date >= CAST(${range.from} AS date) AND a.auction_date::date <= CAST(${range.to} AS date)`
      : sql``;
    const res = await db.execute<{
      id: number;
      auction_number: string | null;
      auction_type: string | null;
      client_id: number | null;
      client_name: string | null;
      start_time: string | null;
      auction_date: string | null;
      lot_count: number;
      approved_lot_count: number;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number, a.auction_type,
             a.client_id, c.company_name AS client_name,
             to_char(a.auction_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
             COALESCE(ls.lot_count, 0)::int AS lot_count,
             COALESCE(ls.approved_lot_count, 0)::int AS approved_lot_count
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      LEFT JOIN (
        SELECT l.auction_id,
               COUNT(*)::int AS lot_count,
               COUNT(*) FILTER (WHERE l.is_approved IS TRUE)::int AS approved_lot_count
        FROM auction_lots l
        WHERE l.is_active = true
        GROUP BY l.auction_id
      ) ls ON ls.auction_id = a.auction_id
      WHERE a.status = 'closed' AND a.is_active = true
        ${clientClause}
        ${dateClause}
      ORDER BY c.company_name NULLS LAST, a.auction_date DESC, a.auction_id
    `);
    const urlsByAuction = await pgActiveCatalogueAndTncUrls(
      res.rows.map((r) => r.id),
    );
    return res.rows.map((r) => {
      const urls = urlsByAuction.get(r.id);
      return {
        clientId: r.client_id,
        clientName: r.client_name,
        auctionId: r.id,
        auctionNumber: r.auction_number,
        auctionType: r.auction_type,
        startTime: r.start_time,
        auctionDate: r.auction_date,
        status: "closed" as const,
        catalogueUrl: urls?.catalogueUrl ?? null,
        tncUrl: urls?.tncUrl ?? null,
        lotCount: r.lot_count ?? 0,
        approvedLotCount: r.approved_lot_count ?? 0,
      };
    });
  }

  /**
   * Client auction detail. The API picks the lot body from status; live
   * (schedule bucket on published auctions) stays on the shared live route.
   */
  async portalAuctionDetail(userId: number, auctionId: number) {
    const header = await db.execute<{
      id: number;
      status: string;
      auction_number: string | null;
      auction_type: string | null;
      client_id: number | null;
      client_name: string | null;
      auction_date: string | null;
      first_start_sec: number | null;
      last_end_sec: number | null;
    }>(sql`
      SELECT a.auction_id AS id, a.status, a.auction_number, a.auction_type,
             a.client_id, c.company_name AS client_name,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
             (SELECT EXTRACT(EPOCH FROM ((min(a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now()))::int
                FROM auction_lots l WHERE l.auction_id = a.auction_id AND l.is_active) AS first_start_sec,
             (SELECT EXTRACT(EPOCH FROM ((max(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'))) - now()))::int
                FROM auction_lots l WHERE l.auction_id = a.auction_id AND l.is_active) AS last_end_sec
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      INNER JOIN user_clients uc
        ON uc.client_id = a.client_id AND uc.user_id = ${userId} AND uc.is_active = true
      WHERE a.auction_id = ${auctionId}
        AND a.status IN ('published', 'closed')
        AND a.is_active = true
        -- Published auctions stay hidden until the scheduled publish time;
        -- closed auctions have already passed it.
        AND (a.status = 'closed' OR a.published_at <= now())
      LIMIT 1
    `);
    const auction = header.rows[0];
    if (!auction) return null;

    const meta = {
      auctionId: auction.id,
      auctionNumber: auction.auction_number,
      auctionType: auction.auction_type,
      clientId: auction.client_id,
      clientName: auction.client_name,
      auctionDate: auction.auction_date,
      status: auction.status,
    };

    if (auction.status === "closed") {
      const lots = await this.portalClosedLots(userId, auctionId);
      return {
        view: "closed" as const,
        auction: meta,
        lots: lots?.lots ?? [],
      };
    }

    const isLive =
      (auction.first_start_sec == null || auction.first_start_sec <= 0) &&
      (auction.last_end_sec == null || auction.last_end_sec > 0);
    if (isLive) {
      return { view: "live" as const, auction: meta };
    }

    const lots = await this.portalUpcomingLots(userId, auctionId);
    return {
      view: "upcoming" as const,
      auction: meta,
      lots: lots?.lots ?? [],
    };
  }

  /**
   * Closed-auction lots for client portal lot approval (status, taxes, review).
   */
  async portalApprovalLots(userId: number, auctionId: number) {
    const header = await db.execute<{
      id: number;
      auction_number: string | null;
      auction_type: string | null;
      client_name: string | null;
      auction_date: string | null;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number, a.auction_type,
             c.company_name AS client_name,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      INNER JOIN user_clients uc
        ON uc.client_id = a.client_id AND uc.user_id = ${userId} AND uc.is_active = true
      WHERE a.auction_id = ${auctionId}
        AND a.status = 'closed'
        AND a.is_active = true
      LIMIT 1
    `);
    const auction = header.rows[0];
    if (!auction) return null;

    const lots = await pgListLots(auctionId);
    const itemNameRes = await db.execute<{
      lot_id: number;
      item_name: string | null;
    }>(sql`
      SELECT DISTINCT ON (ali.lot_id)
             ali.lot_id,
             COALESCE(i.name, ali.material_name) AS item_name
      FROM auction_lot_items ali
      LEFT JOIN items i ON i.id = ali.item_id
      WHERE ali.auction_id = ${auctionId}
        AND ali.is_active = true
      ORDER BY ali.lot_id, ali.id
    `);
    const itemNameByLot = new Map(
      itemNameRes.rows.map((r) => [r.lot_id, r.item_name]),
    );

    return {
      auctionId: auction.id,
      auctionNumber: auction.auction_number,
      auctionType: auction.auction_type,
      clientName: auction.client_name,
      auctionDate: auction.auction_date,
      lots: lots.map((l) => ({
        lotId: l.lotId,
        lotNumber: l.lotNumber,
        quantity: l.quantity,
        uom: l.uom,
        startBidPrice: l.startBidPrice,
        winningPrice: l.winingAmount,
        winnerBidderId: l.winnerCompId,
        winnerBidderName: l.winnerName,
        bidCount: l.bidCount ?? 0,
        bidderCount: l.bidderCount ?? 0,
        gstPercentage: l.gstPercentage,
        tcsPercentage: l.tcsPercentage,
        isApproved: l.isApproved,
        remark: l.remark,
        reviewedAt: l.reviewedAt,
        reviewedByName: l.reviewedByName,
        plantLocationName: l.plantLocationName,
        itemName: itemNameByLot.get(l.lotId) ?? null,
      })),
    };
  }

  /**
   * Closed-auction lots for a company the portal user belongs to, including
   * winner identity and bid counts for the client lot grid.
   */
  async portalClosedLots(userId: number, auctionId: number) {
    const header = await db.execute<{
      id: number;
      auction_number: string | null;
      auction_type: string | null;
      client_name: string | null;
      auction_date: string | null;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number, a.auction_type,
             c.company_name AS client_name,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      INNER JOIN user_clients uc
        ON uc.client_id = a.client_id AND uc.user_id = ${userId} AND uc.is_active = true
      WHERE a.auction_id = ${auctionId}
        AND a.status = 'closed'
        AND a.is_active = true
      LIMIT 1
    `);
    const auction = header.rows[0];
    if (!auction) return null;

    const lots = await db.execute<{
      id: number;
      lot_number: string | null;
      start_time: string | null;
      end_time: string | null;
      quantity: string | null;
      uom: string | null;
      start_bid_price: string | null;
      bid_increment: string | null;
      winning_amount: string | null;
      winner_bidder_id: number | null;
      winner_bidder_name: string | null;
      bid_count: number;
      bidder_count: number;
    }>(sql`
      SELECT l.id, l.lot_number, l.quantity, u.code AS uom,
             l.start_bid_price, l.bid_increment,
             l.winning_amount,
             l.winner_bidder_id, wb.company_name AS winner_bidder_name,
             l.bid_count, l.bidder_count,
             to_char(a.auction_date::date + l.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(
               COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)),
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS end_time
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN bidders wb ON wb.id = l.winner_bidder_id
      WHERE l.auction_id = ${auctionId} AND l.is_active = true
      ORDER BY l.display_order NULLS LAST, l.id
    `);

    return {
      auctionId: auction.id,
      auctionNumber: auction.auction_number,
      auctionType: auction.auction_type,
      clientName: auction.client_name,
      auctionDate: auction.auction_date,
      lots: lots.rows.map((r) => ({
        id: r.id,
        lotNumber: r.lot_number,
        startTime: r.start_time,
        endTime: r.end_time,
        quantity: r.quantity != null ? Number(r.quantity) : null,
        uom: r.uom,
        startBidPrice:
          r.start_bid_price != null ? Number(r.start_bid_price) : null,
        bidIncrement:
          r.bid_increment != null ? Number(r.bid_increment) : null,
        winningPrice:
          r.winning_amount != null ? Number(r.winning_amount) : null,
        winnerBidderId: r.winner_bidder_id,
        winnerBidderName: r.winner_bidder_name,
        bidCount: r.bid_count ?? 0,
        bidderCount: r.bidder_count ?? 0,
      })),
    };
  }

  /**
   * Lot-wise details for a published auction the portal user belongs to.
   * Upcoming lots do not include winner or bidder identity.
   */
  async portalUpcomingLots(userId: number, auctionId: number) {
    const header = await db.execute<{
      id: number;
      auction_number: string | null;
      auction_type: string | null;
      client_name: string | null;
      start_time: string | null;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number, a.auction_type,
             c.company_name AS client_name,
             to_char(
               COALESCE(
                 (SELECT min(a.auction_date::date + l.start_time)
                    FROM auction_lots l
                    WHERE l.auction_id = a.auction_id AND l.is_active),
                 a.auction_date
               ), 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      INNER JOIN user_clients uc
        ON uc.client_id = a.client_id AND uc.user_id = ${userId} AND uc.is_active = true
      WHERE a.auction_id = ${auctionId}
        AND a.status = 'published'
        AND a.published_at <= now()
        AND a.is_active = true
      LIMIT 1
    `);
    const auction = header.rows[0];
    if (!auction) return null;

    const lots = await db.execute<{
      id: number;
      lot_number: string | null;
      start_time: string | null;
      end_time: string | null;
      quantity: string | null;
      uom: string | null;
      start_bid_price: string | null;
      bid_increment: string | null;
    }>(sql`
      SELECT l.id, l.lot_number, l.quantity, u.code AS uom,
             l.start_bid_price, l.bid_increment,
             to_char(a.auction_date::date + l.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(
               COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)),
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS end_time
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      WHERE l.auction_id = ${auctionId} AND l.is_active = true
      ORDER BY l.display_order NULLS LAST, l.id
    `);

    return {
      auctionId: auction.id,
      auctionNumber: auction.auction_number,
      auctionType: auction.auction_type,
      clientName: auction.client_name,
      startTime: auction.start_time,
      lots: lots.rows.map((r) => ({
        id: r.id,
        lotNumber: r.lot_number,
        startTime: r.start_time,
        endTime: r.end_time,
        quantity: r.quantity != null ? Number(r.quantity) : null,
        uom: r.uom,
        startBidPrice:
          r.start_bid_price != null ? Number(r.start_bid_price) : null,
        bidIncrement:
          r.bid_increment != null ? Number(r.bid_increment) : null,
      })),
    };
  }

  private async scheduledAuctions(opts: {
    when: "today" | "future";
    userId?: number;
  }): Promise<
    {
      clientId: number | null;
      clientName: string | null;
      auctionId: number;
      auctionNumber: string | null;
      auctionType: string | null;
      startTime: string | null;
      auctionDate: string | null;
      status: "live" | "upcoming";
      catalogueUrl: string | null;
      tncUrl: string | null;
    }[]
  > {
    const dateClause =
      opts.when === "today"
        ? sql`AND a.auction_date::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`
        : sql`AND a.auction_date::date > (now() AT TIME ZONE 'Asia/Kolkata')::date`;
    const clientClause =
      opts.userId != null
        ? sql`AND a.client_id IN (
            SELECT uc.client_id FROM user_clients uc
            WHERE uc.user_id = ${opts.userId} AND uc.is_active = true
          )`
        : sql``;
    // Portal callers (userId set) must wait for the scheduled publish time;
    // the admin's own "Today's Auctions" dashboard (no userId) sees it as
    // soon as it's published, same as the admin's other auction views.
    const publishedAtClause =
      opts.userId != null ? sql`AND a.published_at <= now()` : sql``;
    const res = await db.execute<{
      id: number;
      auction_number: string | null;
      auction_type: string | null;
      client_id: number | null;
      client_name: string | null;
      start_time: string | null;
      auction_date: string | null;
      first_start_sec: number | null;
      last_end_sec: number | null;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number, a.auction_type,
             a.client_id, c.company_name AS client_name,
             to_char(
               COALESCE(
                 (SELECT min(a.auction_date::date + l.start_time)
                    FROM auction_lots l
                    WHERE l.auction_id = a.auction_id AND l.is_active),
                 a.auction_date
               ), 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
             (SELECT EXTRACT(EPOCH FROM ((min(a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now()))::int
                FROM auction_lots l WHERE l.auction_id = a.auction_id AND l.is_active) AS first_start_sec,
             (SELECT EXTRACT(EPOCH FROM ((max(COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'))) - now()))::int
                FROM auction_lots l WHERE l.auction_id = a.auction_id AND l.is_active) AS last_end_sec
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.status = 'published' AND a.is_active = true
        ${dateClause}
        ${clientClause}
        ${publishedAtClause}
      ORDER BY c.company_name NULLS LAST, start_time, a.auction_id
    `);
    const open = res.rows.filter(
      (r) => r.last_end_sec == null || r.last_end_sec > 0,
    );
    const urlsByAuction = await pgActiveCatalogueAndTncUrls(
      open.map((r) => r.id),
    );
    return open.map((r) => {
      const status: "live" | "upcoming" =
        r.first_start_sec != null && r.first_start_sec > 0
          ? "upcoming"
          : "live";
      const urls = urlsByAuction.get(r.id);
      return {
        clientId: r.client_id,
        clientName: r.client_name,
        auctionId: r.id,
        auctionNumber: r.auction_number,
        auctionType: r.auction_type,
        startTime: r.start_time,
        auctionDate: r.auction_date,
        status,
        catalogueUrl: urls?.catalogueUrl ?? null,
        tncUrl: urls?.tncUrl ?? null,
      };
    });
  }

  /**
   * Registered bidders for an auction with live participation state, for the
   * dashboard "View Participants" modal: company, their login id, whether they
   * are currently logged in, and whether they have accepted the auction's T&C.
   */
  async auctionParticipants(auctionId: number): Promise<
    {
      bidderId: number;
      companyName: string | null;
      userId: number | null;
      loginId: string | null;
      isLoggedIn: boolean;
      tncAccepted: boolean;
    }[]
  > {
    await this.assertExists(auctionId);
    const res = await db.execute<{
      bidder_id: number;
      company_name: string | null;
      user_id: number | null;
      login_id: string | null;
      is_logged_in: boolean;
      tnc_accepted: boolean;
    }>(sql`
      SELECT DISTINCT b.id AS bidder_id, b.company_name,
             u.id AS user_id,
             u.user_login_name AS login_id,
             COALESCE(u.is_login, false) AS is_logged_in,
             EXISTS (
               SELECT 1 FROM auction_tnc_acceptances t
               WHERE t.auction_id = ${auctionId} AND t.bidder_id = b.id
             ) AS tnc_accepted
      FROM auction_lot_bidder_maps m
      JOIN bidders b ON b.id = m.bidder_id
      LEFT JOIN users u ON u.bidder_id = b.id
      WHERE m.auction_id = ${auctionId} AND m.is_active = true
      ORDER BY b.company_name
    `);
    return res.rows.map((r) => ({
      bidderId: r.bidder_id,
      companyName: r.company_name,
      userId: r.user_id != null ? Number(r.user_id) : null,
      loginId: r.login_id,
      isLoggedIn: r.is_logged_in === true,
      tncAccepted: r.tnc_accepted === true,
    }));
  }

  async listDocuments(
    auctionId: number,
    opts: AuctionDocumentsListParams = {
      page: 1,
      pageSize: 10,
    },
  ) {
    await this.assertExists(auctionId);
    const result = await pgListAuctionDocumentsPaginated(auctionId, opts);
    return {
      items: result.items.map((d) => ({
        id: d.id,
        documentTypeId: d.documentTypeId,
        documentTypeName: d.documentTypeName,
        fileName: d.fileName,
        fileSize: d.fileSize,
        isActive: d.isActive,
        createDatetime: d.createDatetime,
        uploadedByName: d.uploadedByName,
        downloadUrl: d.downloadUrl,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  async activeCatalogueDownloadUrl(auctionId: number) {
    await this.assertExists(auctionId);
    return pgActiveCatalogueDownloadUrl(auctionId);
  }

  async activeTncDownloadUrl(auctionId: number) {
    await this.assertExists(auctionId);
    return pgActiveTncDownloadUrl(auctionId);
  }

  async uploadDocument(
    auctionId: number,
    opts: {
      documentTypeId: number;
      buffer: Buffer;
      originalFileName: string;
    },
    userId: number,
  ) {
    await this.assertExists(auctionId);
    const rows = await db
      .select({
        status: auctions.status,
        auctionDate: auctions.auctionDate,
        ...sealedGateColumns,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AuctionNotFoundError();
    const lots = await pgLotTimes(auctionId).catch(() => []);
    if (
      !canEditAuctionContent({
        status: row.status as AuctionStatus,
        auctionDate: row.auctionDate,
        lots,
        ...sealedGateInputOf(row),
      })
    ) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.DOCUMENTS_EDIT_REQUIRES_DRAFT_OR_PRE_LIVE,
      );
    }
    const clientId = await pgGetAuctionClientId(auctionId);
    if (!clientId) throw new AuctionNotFoundError();
    try {
      return await pgUploadAuctionDocument({
        auctionId,
        clientId,
        documentTypeId: opts.documentTypeId,
        buffer: opts.buffer,
        originalFileName: opts.originalFileName,
        userId,
      });
    } catch (err) {
      if (err instanceof Error) {
        throw new AuctionValidationError(err.message);
      }
      throw err;
    }
  }

  async approvalLots(auctionId: number) {
    await this.assertExists(auctionId);
    const lots = await pgListLots(auctionId);
    const withWinners = await Promise.all(
      lots.map(async (l) => ({
        lotId: l.lotId,
        lotNumber: l.lotNumber,
        displayOrder: l.displayOrder,
        quantity: l.quantity,
        uom: l.uom,
        winingAmount: l.winingAmount,
        winnerName: await pgWinnerName(l.winnerCompId),
        isApproved: l.isApproved,
        reviewedAt: l.reviewedAt,
        reviewedBy: l.reviewedBy,
      })),
    );
    return { lots: withWinners };
  }

  async approveLots(
    auctionId: number,
    opts: { lotIds?: number[]; all?: boolean },
    userId: number,
  ) {
    await this.assertExists(auctionId);
    const statusRows = await db
      .select({ status: auctions.status })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const currentStatus = statusRows[0]?.status;
    if (!currentStatus || !canApproveLots(currentStatus)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_APPROVE_REQUIRE_CLOSED,
      );
    }

    if (opts.all) {
      await assertLotsHaveWinningForApproval(auctionId, "all");
      await assertLotDecisionsChangeable(auctionId, "all");
      await pgApproveLots(auctionId, "all", userId);
      const bidderIds = await winnerBidderIdsForLots(auctionId, "all");
      await syncLotConfirmationPdf(auctionId, bidderIds, userId);
    } else if (opts.lotIds?.length) {
      await assertLotsHaveWinningForApproval(auctionId, opts.lotIds);
      await assertLotDecisionsChangeable(auctionId, opts.lotIds);
      await pgApproveLots(auctionId, opts.lotIds, userId);
      const bidderIds = await winnerBidderIdsForLots(auctionId, opts.lotIds);
      await syncLotConfirmationPdf(auctionId, bidderIds, userId);
    }
  }

  async rejectLots(
    auctionId: number,
    opts: { lotIds?: number[]; all?: boolean },
    userId: number,
  ) {
    await this.assertExists(auctionId);
    const statusRows = await db
      .select({ status: auctions.status })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const currentStatus = statusRows[0]?.status;
    if (!currentStatus || !canRejectLots(currentStatus)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_REJECT_REQUIRE_CLOSED,
      );
    }

    if (opts.all) {
      const bidderIds = await winnerBidderIdsForLots(auctionId, "all");
      await pgRejectLots(auctionId, "all", userId);
      await emdBlocksService.releaseOnLotRejection(auctionId, "all", userId);
      await syncLotConfirmationPdf(auctionId, bidderIds, userId);
    } else if (opts.lotIds?.length) {
      const bidderIds = await winnerBidderIdsForLots(auctionId, opts.lotIds);
      await pgRejectLots(auctionId, opts.lotIds, userId);
      await emdBlocksService.releaseOnLotRejection(auctionId, opts.lotIds, userId);
      await syncLotConfirmationPdf(auctionId, bidderIds, userId);
    }
  }

  async saveLotApprovals(
    auctionId: number,
    entries: SaveLotApprovalEntry[],
    userId: number,
  ) {
    await this.assertExists(auctionId);
    const statusRows = await db
      .select({ status: auctions.status })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const currentStatus = statusRows[0]?.status;
    if (!currentStatus || !canApproveLots(currentStatus)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_APPROVALS_REQUIRE_CLOSED,
      );
    }

    const approveLotIds = [
      ...new Set(
        entries.filter((e) => e.isApproved === true).map((e) => e.lotId),
      ),
    ];
    await assertLotsHaveWinningForApproval(auctionId, approveLotIds);
    await assertLotDecisionsChangeable(auctionId, [
      ...new Set(
        entries
          .filter((e) => e.isApproved !== undefined && e.isApproved !== false)
          .map((e) => e.lotId),
      ),
    ]);

    const statusLotIds = [
      ...new Set(
        entries
          .filter((e) => e.isApproved === true || e.isApproved === false)
          .map((e) => e.lotId),
      ),
    ];
    await pgSaveLotApprovals(auctionId, entries, userId);
    await emdBlocksService.releaseOnLotRejection(
      auctionId,
      [...new Set(entries.filter((e) => e.isApproved === false).map((e) => e.lotId))],
      userId,
    );
    if (statusLotIds.length > 0) {
      const bidderIds = await winnerBidderIdsForLots(auctionId, statusLotIds);
      await syncLotConfirmationPdf(auctionId, bidderIds, userId);
    }
  }

  async notifyWinners(auctionId: number, lotIds: number[], userId: number) {
    await this.assertExists(auctionId);
    const statusRows = await db
      .select({ status: auctions.status })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const currentStatus = statusRows[0]?.status;
    if (!currentStatus || !canApproveLots(currentStatus)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_NOTIFY_REQUIRE_CLOSED,
      );
    }
    return notifyLotConfirmationWinners(auctionId, lotIds, userId);
  }

  async noBidLots(auctionId: number) {
    await this.assertExists(auctionId);
    const rows = await pgNoBidLots(auctionId);
    const lots = rows.map((r) => {
      const status = deriveNoBidLotStatus({
        noBidExtensionCountMax: r.noBidExtensionCountMax,
        noBidExtensionCount: r.noBidExtensionCount,
        isNoBidExtension: r.isNoBidExtension,
        isReopened: r.isReopened,
      });
      return {
        lotId: r.lotId,
        lotNumber: r.lotNumber,
        displayOrder: r.displayOrder,
        startTime: r.startTime,
        endTime: r.endTime,
        quantity: r.quantity,
        uom: r.uom,
        startBidPrice: r.startBidPrice,
        noBidExtensionCountMax: r.noBidExtensionCountMax,
        noBidExtensionCount: r.noBidExtensionCount,
        status,
        stoppedAt: r.noBidExtensionStoppedAt,
        stoppedByName: r.noBidExtensionStoppedByName,
        isSelectable: status === "Active",
      };
    });
    return { lots };
  }

  async stopNoBidExtensionAll(auctionId: number, userId: number) {
    await this.assertPublishedAndLive(auctionId, {
      notPublished:
        AuctionsValidationMessages.NO_BID_EXTENSION_STOP_REQUIRES_PUBLISHED,
      notLive: AuctionsValidationMessages.NO_BID_EXTENSION_STOP_REQUIRES_LIVE,
    });
    await pgStopNoBidExtensionAll(auctionId, userId);
  }

  async stopNoBidExtensionLots(
    auctionId: number,
    lotIds: number[],
    userId: number,
  ) {
    await this.assertPublishedAndLive(auctionId, {
      notPublished:
        AuctionsValidationMessages.NO_BID_EXTENSION_STOP_REQUIRES_PUBLISHED,
      notLive: AuctionsValidationMessages.NO_BID_EXTENSION_STOP_REQUIRES_LIVE,
    });
    if (lotIds.length === 0) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.SELECT_AT_LEAST_ONE_LOT,
      );
    }
    await pgStopNoBidExtensionLots(auctionId, lotIds, userId);
  }

  async applyLotCorrection(
    auctionId: number,
    lotId: number,
    body: LotCorrectionBody,
    userId: number,
  ) {
    await this.assertExists(auctionId);
    const status = await pgGetAuctionStatus(auctionId);
    if (!status) {
      throw new AuctionNotFoundError();
    }
    const auctionStatus = status as AuctionStatus;

    // Single-lot reopen shares the bulk reopen's phase rules (live or closed).
    if (body.type === "reopen_lot") {
      const reopenBody = await pgSingleLotReopenBody(
        auctionId,
        lotId,
        body.lotEndTime,
      );
      await this.applyReopenLotsCorrection(auctionId, reopenBody, userId);
      return;
    }

    if (
      body.type === "remove_winning_bid" ||
      body.type === "remove_all_bids"
    ) {
      // Execution phase only, and only while the auction is live.
      if (!isPhase2Status(auctionStatus)) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.BID_REMOVAL_REQUIRES_EXECUTION,
        );
      }
      await this.assertAuctionIsLive(
        auctionId,
        AuctionsValidationMessages.BID_REMOVAL_REQUIRES_LIVE,
      );
    } else if (!isPhase3Status(auctionStatus)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.UPDATE_LOT_REQUIRES_CLOSED,
      );
    }

    await pgApplyLotCorrection(auctionId, lotId, body, userId);
  }

  /**
   * EMD picture for a candidate new H1, shown before an admin confirms a
   * winner correction: the additional EMD this lot would need from their
   * wallet, their current live available balance, and their current total
   * Blocked on this auction. Read-only — never blocks or releases anything;
   * `reconcileWinningHoldForCorrection` (run on actually applying the
   * correction) shares the same target computation so the two never disagree.
   */
  async previewLotCorrectionEmd(
    auctionId: number,
    lotId: number,
    bidderId: number,
  ): Promise<{ emdRequired: number; emdAvailable: number; alreadyBlocked: number }> {
    await this.assertExists(auctionId);
    const [lotRow] = await db
      .select({ id: auctionLots.id })
      .from(auctionLots)
      .where(
        and(
          eq(auctionLots.id, lotId),
          eq(auctionLots.auctionId, auctionId),
          eq(auctionLots.isActive, true),
        ),
      )
      .limit(1);
    if (!lotRow) throw new AuctionLotNotFoundError();

    const [{ target }, { total: heldTotal }, [bidderRow], alreadyBlocked] = await Promise.all([
      computeWinningHoldTarget(db, { auctionId, bidderId, extraLotId: lotId }),
      currentWinningHoldTotal(db, auctionId, bidderId),
      db
        .select({ emdAvailableBalance: bidders.emdAvailableBalance })
        .from(bidders)
        .where(eq(bidders.id, bidderId))
        .limit(1),
      emdBlocksService.totalBlockedOnAuction(db, bidderId, auctionId),
    ]);

    return {
      emdRequired: round2(Math.max(target - heldTotal, 0)),
      emdAvailable: toAmount(bidderRow?.emdAvailableBalance),
      alreadyBlocked,
    };
  }

  /**
   * Execution-phase correction: force lot staggering on/off for this one live
   * auction without touching the client's default. Staggering has no
   * in-memory state, so the override takes effect on the next no-bid tick or
   * bid-time extension.
   */
  async applyStaggerCorrection(
    auctionId: number,
    body: StaggerCorrectionBody,
    userId: number,
  ) {
    await this.assertPublishedAndLive(auctionId, {
      notPublished: AuctionsValidationMessages.STAGGER_CORRECTION_REQUIRES_LIVE,
      notLive: AuctionsValidationMessages.STAGGER_CORRECTION_REQUIRES_LIVE,
    });
    await pgApplyStaggerCorrection(auctionId, body, userId);
  }

  async applyReopenLotsCorrection(
    auctionId: number,
    body: ReopenLotsCorrectionBody,
    userId: number,
  ) {
    await this.assertExists(auctionId);
    const status = await pgGetAuctionStatus(auctionId);
    if (!status) {
      throw new AuctionNotFoundError();
    }
    const auctionStatus = status as AuctionStatus;
    if (isPhase3Status(auctionStatus)) {
      await pgReopenLots(auctionId, body, "settlement", userId);
      return;
    }
    if (isPhase2Status(auctionStatus)) {
      await this.assertAuctionIsLive(
        auctionId,
        AuctionsValidationMessages.REOPEN_REQUIRES_LIVE,
      );
      await pgReopenLots(auctionId, body, "live", userId);
      return;
    }
    throw new AuctionValidationError(
      AuctionsValidationMessages.REOPEN_REQUIRES_CLOSED,
    );
  }

  private async getAuctionEmd(auctionId: number) {
    const rows = await db
      .select({ consolidatedEmd: auctions.consolidatedEmdAmount })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    if (!rows[0]) throw new AuctionNotFoundError();
    return {
      consolidatedEmd: rows[0].consolidatedEmd
        ? Number(rows[0].consolidatedEmd)
        : null,
    };
  }

  private async assertExists(auctionId: number) {
    const rows = await db
      .select({ id: auctions.id })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    if (!rows[0]) throw new AuctionNotFoundError();
  }

  private async assertLotWriteCrossFields(
    auctionId: number,
    body: CreateLotBody,
  ) {
    const [auction] = await db
      .select({
        auctionType: auctions.auctionType,
        auctionDate: auctions.auctionDate,
        publishedAt: auctions.publishedAt,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    if (!auction?.auctionDate) {
      throw new AuctionNotFoundError();
    }
    const scheduleErrors: Record<string, string[]> | null =
      collectLotWriteScheduleErrors(
        body.lotStartTime,
        body.lotEndTime,
        auction.auctionDate,
        undefined,
        auction.publishedAt,
      );
    if (scheduleErrors) {
      const first =
        scheduleErrors.lotStartTime?.[0] ??
        scheduleErrors.lotEndTime?.[0] ??
        AuctionsValidationMessages.LOT_TIME_INVALID;
      throw new AuctionValidationError(first, scheduleErrors);
    }
    const err = bidLimitVsStartPriceError(
      auction.auctionType,
      body.bidLimit,
      body.startBidPrice,
    );
    if (err) {
      throw new AuctionValidationError(err, { bidLimit: [err] });
    }
    const bidIncrementErr = bidIncrementVsPriceError(
      body.bidIncrement,
      body.startBidPrice,
      { auctionType: auction.auctionType },
    );
    if (bidIncrementErr) {
      throw new AuctionValidationError(bidIncrementErr, {
        bidIncrement: [bidIncrementErr],
      });
    }
  }

  private async resolveAuctionNumber(
    clientId: number,
    auctionNumber: string | null | undefined,
  ): Promise<string | null> {
    const rows = await db
      .select({ auctionPrefix: clients.auctionPrefix })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    const prefix = rows[0]?.auctionPrefix?.trim() ?? "";
    if (!prefix) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.CLIENT_AUCTION_PREFIX_REQUIRED,
        {
          auctionNumber: [
            AuctionsValidationMessages.CLIENT_AUCTION_PREFIX_REQUIRED,
          ],
        },
      );
    }
    try {
      return buildAuctionNumber(prefix, auctionNumber);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : AuctionsValidationMessages.AUCTION_NUMBER_TOO_LONG;
      throw new AuctionValidationError(message, {
        auctionNumber: [message],
      });
    }
  }

  private async assertAuctionNumberAvailable(
    clientId: number,
    auctionNumber: string | null,
    excludeAuctionId?: number,
  ): Promise<void> {
    if (!auctionNumber) return;

    const conditions: SQL[] = [
      eq(auctions.clientId, clientId),
      eq(auctions.auctionNumber, auctionNumber),
      eq(auctions.isActive, true),
      ne(auctions.status, "archived"),
    ];
    if (excludeAuctionId != null) {
      conditions.push(ne(auctions.id, excludeAuctionId));
    }

    const rows = await db
      .select({ id: auctions.id })
      .from(auctions)
      .where(and(...conditions))
      .limit(1);

    if (rows[0]) {
      throw duplicateAuctionNumberError();
    }
  }

  private async assertEditableForLotWrites(
    auctionId: number,
    isReopened = false,
  ) {
    const status = await pgGetAuctionStatus(auctionId);
    if (status == null) throw new AuctionNotFoundError();
    if (!canEditLotContent(status as AuctionStatus, isReopened)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOTS_EDIT_REQUIRES_DRAFT_OR_PRE_LIVE,
      );
    }
  }

  /**
   * Blanket gate for the Auction Settings fields with no other
   * status-aware check. Only throws when the patch actually touches one of
   * them while the auction is closed.
   */
  private assertAuctionSettingsFieldsEditable(
    status: AuctionStatus,
    body: PatchAuctionBody,
  ): void {
    if (canEditAuctionSettingsFields(status)) return;
    const gatedFields = [
      "auctionNumber",
      "auctionType",
      "publishedAt",
      "noBidExtensionInterval",
      "noBidExtensionCountMax",
      "isNoBidExtension",
      "isStartBidPricePlusIncrement",
      "ipAddressRestrictionEnabled",
      "isRankBased",
    ] as const satisfies ReadonlyArray<keyof PatchAuctionBody>;
    const touched = gatedFields.some((field) => body[field] !== undefined);
    if (touched) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.AUCTION_SETTINGS_EDIT_REQUIRES_NOT_CLOSED,
      );
    }
  }

  /**
   * Edits to a published auction no longer unpublish it. A few destructive
   * writes still need the explicit "Move to Draft" first.
   */
  private async assertDraftStatus(auctionId: number) {
    const [row] = await db
      .select({ status: auctions.status })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    if (!row) throw new AuctionNotFoundError();
    if (row.status !== "draft") {
      throw new AuctionValidationError(
        AuctionsValidationMessages.PUBLISHED_EDIT_REQUIRES_DRAFT,
      );
    }
  }

  private async assertBiddersVerified(bidderIds: number[]): Promise<void> {
    const unique = [...new Set(bidderIds)].filter(
      (id) => Number.isInteger(id) && id > 0,
    );
    if (unique.length === 0) return;
    const [row] = await db
      .select({ id: bidders.id })
      .from(bidders)
      .where(and(inArray(bidders.id, unique), eq(bidders.isVerified, false)))
      .limit(1);
    if (row) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.BIDDER_NOT_VERIFIED_FOR_ATTACH,
      );
    }
  }

  /** @deprecated Prefer assertEditableForLotWrites */
  private async assertDraftForLotWrites(auctionId: number) {
    await this.assertEditableForLotWrites(auctionId);
  }

  // Attach Bidders is an execution-era action. Allowed only while published —
  // not while draft/archived (no live round exists yet) or closed.
  private async assertPublishedForBidderWrites(auctionId: number) {
    await this.assertExists(auctionId);
    const status = await pgGetAuctionStatus(auctionId);
    const allowed = status != null && canEditExecutionContent(status as AuctionStatus);
    if (!allowed) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.BIDDERS_ATTACH_REQUIRES_PUBLISHED,
      );
    }
  }

  // EMD config is editable while published, including with bidders already
  // attached — a new lot may be added mid-auction, needing its own EMD
  // range and bidder attachments. Locked once closed.
  private async assertPublishedForEmdWrites(auctionId: number) {
    await this.assertExists(auctionId);
    const status = await pgGetAuctionStatus(auctionId);
    const allowed = status != null && canEditExecutionContent(status as AuctionStatus);
    if (!allowed) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.EMD_WRITES_REQUIRE_PUBLISHED,
      );
    }
  }

  /**
   * The consolidated EMD amount is an auction-wide ceiling, not scoped to a
   * single range, so (unlike a per-range edit) it has no narrower "only the
   * lots it covers" scope to check — it's locked outright once any bidder is
   * attached anywhere on the auction.
   */
  private async assertNoBiddersAttached(auctionId: number) {
    const lotBidders = await pgLotBidderSummary(auctionId);
    if (lotBidders.some((l) => l.bidderCount > 0)) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.EMD_LOCKED_AFTER_BIDDERS_ATTACHED,
      );
    }
  }

  private async assertEmdSetForBidderWrites(auctionId: number) {
    const stats = await pgAuctionStats(auctionId);
    if (!stats.lotEmdSet) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.EMD_REQUIRED_BEFORE_ATTACH,
      );
    }
  }

  private async assertPublishedAndLive(
    auctionId: number,
    messages: { notPublished: string; notLive: string },
  ) {
    await this.assertExists(auctionId);
    const status = await pgGetAuctionStatus(auctionId);
    if (status !== "published") {
      throw new AuctionValidationError(messages.notPublished);
    }
    await this.assertAuctionIsLive(auctionId, messages.notLive);
  }

  private async assertAuctionIsLive(auctionId: number, message: string) {
    const rows = await db
      .select({ auctionDate: auctions.auctionDate })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AuctionNotFoundError();
    const lots = await pgLotTimes(auctionId);
    if (deriveScheduleBucket(row.auctionDate, lots) !== "live") {
      throw new AuctionValidationError(message);
    }
  }
}

export const auctionsService = new AuctionsService();

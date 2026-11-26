import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import {
  auctionLotBidderMaps,
  auctionDocuments,
  auctionDocumentTypes,
  auctionLotEmdRanges,
  auctionLotItems,
  auctionLots,
  auctionLotConfirmationDocuments,
  auctions,
  auctionBids,
  auctionBidLogs,
  auctionProxyBids,
  auctionLotWatchlist,
  auctionLotExtensions,
  benchmarkLocations,
  benchmarkMaterialLocations,
  benchmarkMaterials,
  bidders,
  items,
  liftingClientLogs,
  liftingEngagementLogs,
  materialLocations,
  plantLocations,
  uoms,
  users,
  AUCTION_DOCUMENT_TYPE_CATALOGUE,
  AUCTION_DOCUMENT_TYPE_TNC,
  clients,
} from "../db/schema/index.js";
import {
  assertDisplayOrderAvailable,
  normalizeDisplayOrderKey,
} from "../lib/auction-lot-display-order.js";
import type { AuctionLotWriteBody } from "../lib/auction-lot-write-schema.js";
import {
  unionBidderMaterialsMany,
  unionClientBidders,
  unionClientMaterials,
  type SqlExecutor,
} from "../lib/array-set.js";
import { blockedBidderIdsForClient } from "../lib/bidders/blocked-for-client.js";
import type {
  AuctionDocumentsListParams,
  LotCorrectionBody,
  ReopenLotsCorrectionBody,
  StaggerCorrectionBody,
} from "../lib/auctions/schemas.js";
import {
  AuctionsErrorMessages,
  AuctionsValidationMessages,
} from "@auctionit/messages/auctions";
import { AuctionValidationError } from "./auctions-errors.js";
import { uploadAuctionDocumentBytesToR2 } from "../lib/auction-document-upload.js";
import {
  assertAuctionDocumentFile,
  extensionForAuctionDocumentKind,
  resolveAuctionDocumentStorage,
  sniffAuctionDocumentKind,
} from "../lib/auction-r2-keys.js";
import {
  assertSaveable,
  checkEmdTotals,
  sumRangeEmd,
} from "../lib/auctions/emd-range-validation.js";
import { deleteObject, getObjectBuffer, getSignedDownloadUrl } from "../lib/r2.js";
import { CLIENT_DOCUMENT_TYPE_TNC } from "../db/schema/client-document-types.js";
import { clampPagination } from "./list-query.js";
import { getLatestClientDocumentStorageRef } from "./client-documents.service.js";
import { formatUtcNow } from "@auctionit/lib/date";
import { bidLimitVsStartPriceError } from "@auctionit/lib/bid-limit-vs-start";
import { bidIncrementVsPriceError } from "@auctionit/lib/bid-increment-vs-price";
import { manualBidAmountError } from "@auctionit/lib/live-bid-bounds";
import {
  auctionDateIsoForInstant,
  isLotEndTimeAfterNow,
} from "@auctionit/lib/lot-schedule";
import {
  effectiveLotEnd,
  isAuctionDateToday,
  parseLotDateTime,
} from "../lib/auctions/status.js";
import { shouldStagger } from "../lib/auctions/stagger.js";
import { clearLotExtensionState } from "../lib/auctions/clear-lot-extension-state.js";
import {
  amountsEqual,
  classifyUpdateLotCase,
  CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS,
  isWinnerInClientBidders,
  resolveCorrectionBidCreatedAt,
} from "../lib/auctions/update-lot-correction.js";
import { emdBlocksService } from "./emd-blocks.service.js";
import { type Tx } from "./emd-transactions.service.js";
import { emdSettlementService } from "./emd-settlement.service.js";
import { reconcileWinningHoldForCorrection } from "./emd-winning-hold.service.js";
import { CLOSE_LOCK_KEY } from "./auction-close.service.js";
import { NO_BID_EXTENSION_PENDING } from "./no-bid-extension.service.js";

const lotEmailedByUsers = alias(users, "lot_emailed_by_users");
const lotReviewedByUsers = alias(users, "lot_reviewed_by_users");

export type PgLotRow = {
  lotId: number;
  lotNumber: string | null;
  quantity: number | null;
  uom: string | null;
  startBidPrice: number | null;
  displayOrder: number | null;
  status: number | null;
  winnerUserId: number | null;
  winingAmount: number | null;
  lotStartTime: string | null;
  lotEndTime: string | null;
  /** Effective end time-of-day (HH:mm:ss), including stagger extensions. */
  lotEffectiveEndTime?: string | null;
  bidIncrement: number | null;
  bidLimit: number | null;
  isApproved: boolean | null;
  reviewedAt: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  winnerCompId: number | null;
  winnerName: string | null;
  clientId: number;
  auctionId: number;
  materialLiftingDays: number | null;
  plantLocationId: number | null;
  materialLocationId: number | null;
  plantLocationName: string | null;
  materialLocationName: string | null;
  loadingScope: string | null;
  gstPercentage: number | null;
  tcsPercentage: number | null;
  remark: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  emailedAt: string | null;
  emailedByName: string | null;
  bidCount: number;
  bidderCount: number;
  /** Soft-withdrawn lots keep display order but are inactive. */
  isActive: boolean;
  /** Whether the lot's effective end is in the past (live schedule). */
  isClosed?: boolean;
  /** Reopened by an admin: own end time, outside lot staggering, no extensions. */
  isReopened: boolean;
};

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Round a money value to 2 decimals (paise), avoiding float drift. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function mapLotRow(r: {
  id: number;
  lotNumber: string | null;
  quantity: string | null;
  uomCode: string | null;
  startBidPrice: string | null;
  displayOrder: string | null;
  status: number | null;
  winnerUserId: number | null;
  winningAmount: string | null;
  lotStartTime: string | null;
  lotEndTime: string | null;
  lotEffectiveEndTime?: string | null;
  bidIncrement: string | null;
  bidLimit: string | null;
  isApproved: boolean | null;
  reviewedAt: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  winnerBidderId: number | null;
  winnerName: string | null;
  clientId: number;
  auctionId: number;
  materialLiftingDays: number | null;
  plantLocationId: number | null;
  materialLocationId: number | null;
  plantLocationName: string | null;
  materialLocationName: string | null;
  loadingScope: string | null;
  gstPercentage: string | null;
  tcsPercentage: string | null;
  remark: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  emailedAt: string | null;
  emailedByName: string | null;
  bidCount: number;
  bidderCount: number;
  isActive: boolean;
  isClosed?: boolean;
  isReopened: boolean;
}): PgLotRow {
  return {
    lotId: r.id,
    lotNumber: r.lotNumber,
    quantity: num(r.quantity),
    uom: r.uomCode,
    startBidPrice: num(r.startBidPrice),
    displayOrder: num(r.displayOrder),
    status: r.status,
    winnerUserId: r.winnerUserId,
    winingAmount: num(r.winningAmount),
    lotStartTime: r.lotStartTime,
    lotEndTime: r.lotEndTime,
    ...(r.lotEffectiveEndTime !== undefined
      ? { lotEffectiveEndTime: r.lotEffectiveEndTime }
      : {}),
    bidIncrement: num(r.bidIncrement),
    bidLimit: num(r.bidLimit),
    isApproved: r.isApproved,
    reviewedAt: r.reviewedAt,
    reviewedBy: r.reviewedBy,
    reviewedByName: r.reviewedByName,
    winnerCompId: r.winnerBidderId,
    winnerName: r.winnerName,
    clientId: r.clientId,
    auctionId: r.auctionId,
    materialLiftingDays: r.materialLiftingDays,
    plantLocationId: r.plantLocationId,
    materialLocationId: r.materialLocationId,
    plantLocationName: r.plantLocationName,
    materialLocationName: r.materialLocationName,
    loadingScope: r.loadingScope,
    gstPercentage: num(r.gstPercentage),
    tcsPercentage: num(r.tcsPercentage),
    remark: r.remark,
    updatedAt: r.updatedAt,
    updatedByName: r.updatedByName,
    emailedAt: r.emailedAt,
    emailedByName: r.emailedByName,
    bidCount: r.bidCount,
    bidderCount: r.bidderCount,
    isActive: r.isActive,
    ...(r.isClosed !== undefined ? { isClosed: r.isClosed } : {}),
    isReopened: r.isReopened,
  };
}

const lotSelect = {
  id: auctionLots.id,
  lotNumber: auctionLots.lotNumber,
  quantity: auctionLots.quantity,
  uomCode: uoms.code,
  startBidPrice: auctionLots.startBidPrice,
  displayOrder: auctionLots.displayOrder,
  status: auctionLots.status,
  winnerUserId: auctionLots.winnerUserId,
  winningAmount: auctionLots.winningAmount,
  lotStartTime: auctionLots.startTime,
  lotEndTime: auctionLots.endTime,
  bidIncrement: auctionLots.bidIncrement,
  bidLimit: auctionLots.bidLimit,
  isApproved: auctionLots.isApproved,
  reviewedAt: auctionLots.reviewedAt,
  reviewedBy: auctionLots.reviewedBy,
  reviewedByName: lotReviewedByUsers.name,
  winnerBidderId: auctionLots.winnerBidderId,
  winnerName: bidders.companyName,
  clientId: auctionLots.clientId,
  auctionId: auctionLots.auctionId,
  materialLiftingDays: auctionLots.materialLiftingDays,
  plantLocationId: auctionLots.plantLocationId,
  materialLocationId: auctionLots.materialLocationId,
  plantLocationName: plantLocations.name,
  materialLocationName: materialLocations.name,
  loadingScope: auctionLots.loadingScope,
  gstPercentage: auctionLots.gstPercentage,
  tcsPercentage: auctionLots.tcsPercentage,
  remark: auctionLots.remark,
  updatedAt: auctionLots.updatedAt,
  updatedByName: users.name,
  emailedAt: auctionLotConfirmationDocuments.emailSentAt,
  emailedByName: lotEmailedByUsers.name,
  bidCount: auctionLots.bidCount,
  bidderCount: auctionLots.bidderCount,
  isActive: auctionLots.isActive,
  isReopened: auctionLots.isReopened,
};

const lotIsClosedExpr = sql<boolean>`(
  EXTRACT(EPOCH FROM (
    COALESCE(
      ${auctionLots.extendedEndTime},
      (${auctions.auctionDate}::date + ${auctionLots.endTime}) AT TIME ZONE 'Asia/Kolkata'
    ) - now()
  )) <= 0
)`;

export async function pgListLots(auctionId: number): Promise<PgLotRow[]> {
  const rows = await db
    .select({
      ...lotSelect,
      isClosed: lotIsClosedExpr,
    })
    .from(auctionLots)
    .innerJoin(auctions, eq(auctions.id, auctionLots.auctionId))
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .leftJoin(bidders, eq(bidders.id, auctionLots.winnerBidderId))
    .leftJoin(
      plantLocations,
      eq(plantLocations.id, auctionLots.plantLocationId),
    )
    .leftJoin(
      materialLocations,
      eq(materialLocations.id, auctionLots.materialLocationId),
    )
    .leftJoin(users, eq(users.id, auctionLots.updatedBy))
    .leftJoin(
      auctionLotConfirmationDocuments,
      and(
        eq(auctionLotConfirmationDocuments.auctionId, auctionLots.auctionId),
        eq(auctionLotConfirmationDocuments.bidderId, auctionLots.winnerBidderId),
        eq(auctionLotConfirmationDocuments.isActive, true),
      ),
    )
    .leftJoin(
      lotEmailedByUsers,
      eq(lotEmailedByUsers.id, auctionLotConfirmationDocuments.emailSentBy),
    )
    .leftJoin(
      lotReviewedByUsers,
      eq(lotReviewedByUsers.id, auctionLots.reviewedBy),
    )
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.isActive, true)),
    )
    .orderBy(asc(auctionLots.displayOrder), asc(auctionLots.id));
  return rows.map(mapLotRow);
}

export type AuctionLotsListSortBy =
  | "displayOrder"
  | "lotNumber"
  | "startTime"
  | "endTime"
  | "quantity"
  | "startBidPrice"
  | "bidIncrement"
  | "winningAmount"
  | "updatedAt"
  | "reviewedAt";

export type AuctionLotsListParams = {
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: AuctionLotsListSortBy;
  sortOrder?: "asc" | "desc";
  /** When true, include soft-withdrawn lots (creation Lot Settings). */
  includeInactive?: boolean;
};

export type AuctionLotBidderMapListSortBy = "displayOrder" | "lotNumber";

export type AuctionLotBidderMapListParams = {
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: AuctionLotBidderMapListSortBy;
  sortOrder?: "asc" | "desc";
};

function buildLotsSearchCondition(search: string | undefined): SQL | undefined {
  const q = search?.trim();
  if (!q) return undefined;
  const pattern = `%${q}%`;
  // Match UI display-order format (toFixed(3)), not bare cast(numeric as text).
  return or(
    ilike(auctionLots.lotNumber, pattern),
    sql`to_char(${auctionLots.displayOrder}, 'FM9999999990.000') ilike ${pattern}`,
  );
}

function buildLotsOrderBy(
  sortBy: AuctionLotsListSortBy | undefined,
  sortOrder: "asc" | "desc" | undefined,
) {
  const descOrder = sortOrder === "desc";
  const col = (() => {
    switch (sortBy) {
      case "lotNumber":
        return auctionLots.lotNumber;
      case "startTime":
        return auctionLots.startTime;
      case "endTime":
        return auctionLots.endTime;
      case "quantity":
        return auctionLots.quantity;
      case "startBidPrice":
        return auctionLots.startBidPrice;
      case "bidIncrement":
        return auctionLots.bidIncrement;
      case "winningAmount":
        return auctionLots.winningAmount;
      case "updatedAt":
        return auctionLots.updatedAt;
      case "reviewedAt":
        return auctionLots.reviewedAt;
      case "displayOrder":
      default:
        return auctionLots.displayOrder;
    }
  })();
  return descOrder
    ? [desc(col), asc(auctionLots.id)]
    : [asc(col), asc(auctionLots.id)];
}

export async function pgListLotsPaginated(
  auctionId: number,
  opts: AuctionLotsListParams = {},
): Promise<{
  items: PgLotRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const { page, pageSize, offset } = clampPagination(
    opts.page ?? 1,
    opts.pageSize ?? 10,
  );
  const whereExpr = and(
    eq(auctionLots.auctionId, auctionId),
    opts.includeInactive ? undefined : eq(auctionLots.isActive, true),
    buildLotsSearchCondition(opts.search),
  );
  const orderBy = buildLotsOrderBy(opts.sortBy, opts.sortOrder);

  const [countRow] = await db
    .select({ total: count() })
    .from(auctionLots)
    .where(whereExpr);

  const rows = await db
    .select({
      ...lotSelect,
      isClosed: lotIsClosedExpr,
    })
    .from(auctionLots)
    .innerJoin(auctions, eq(auctions.id, auctionLots.auctionId))
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .leftJoin(bidders, eq(bidders.id, auctionLots.winnerBidderId))
    .leftJoin(
      plantLocations,
      eq(plantLocations.id, auctionLots.plantLocationId),
    )
    .leftJoin(
      materialLocations,
      eq(materialLocations.id, auctionLots.materialLocationId),
    )
    .leftJoin(users, eq(users.id, auctionLots.updatedBy))
    .leftJoin(
      auctionLotConfirmationDocuments,
      and(
        eq(auctionLotConfirmationDocuments.auctionId, auctionLots.auctionId),
        eq(auctionLotConfirmationDocuments.bidderId, auctionLots.winnerBidderId),
        eq(auctionLotConfirmationDocuments.isActive, true),
      ),
    )
    .leftJoin(
      lotEmailedByUsers,
      eq(lotEmailedByUsers.id, auctionLotConfirmationDocuments.emailSentBy),
    )
    .leftJoin(
      lotReviewedByUsers,
      eq(lotReviewedByUsers.id, auctionLots.reviewedBy),
    )
    .where(whereExpr)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  return {
    items: rows.map(mapLotRow),
    total: Number(countRow?.total ?? 0),
    page,
    pageSize,
  };
}

export async function pgGetLot(
  auctionId: number,
  lotId: number,
): Promise<PgLotRow | null> {
  const rows = await db
    .select({
      id: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
      quantity: auctionLots.quantity,
      uomCode: uoms.code,
      startBidPrice: auctionLots.startBidPrice,
      displayOrder: auctionLots.displayOrder,
      status: auctionLots.status,
      winnerUserId: auctionLots.winnerUserId,
      winningAmount: auctionLots.winningAmount,
      lotStartTime: auctionLots.startTime,
      lotEndTime: auctionLots.endTime,
      lotEffectiveEndTime: sql<string | null>`to_char(COALESCE(
        ${auctionLots.extendedEndTime},
        (${auctions.auctionDate}::date + ${auctionLots.endTime}) AT TIME ZONE 'Asia/Kolkata'
      ), 'HH24:MI:SS')`,
      bidIncrement: auctionLots.bidIncrement,
      bidLimit: auctionLots.bidLimit,
      isApproved: auctionLots.isApproved,
      reviewedAt: auctionLots.reviewedAt,
      reviewedBy: auctionLots.reviewedBy,
      reviewedByName: lotReviewedByUsers.name,
      winnerBidderId: auctionLots.winnerBidderId,
      winnerName: bidders.companyName,
      clientId: auctionLots.clientId,
      auctionId: auctionLots.auctionId,
      materialLiftingDays: auctionLots.materialLiftingDays,
      plantLocationId: auctionLots.plantLocationId,
      materialLocationId: auctionLots.materialLocationId,
      plantLocationName: plantLocations.name,
      materialLocationName: materialLocations.name,
      loadingScope: auctionLots.loadingScope,
      gstPercentage: auctionLots.gstPercentage,
      tcsPercentage: auctionLots.tcsPercentage,
      remark: auctionLots.remark,
      updatedAt: auctionLots.updatedAt,
      updatedByName: users.name,
      emailedAt: auctionLotConfirmationDocuments.emailSentAt,
      emailedByName: lotEmailedByUsers.name,
      bidCount: auctionLots.bidCount,
      bidderCount: auctionLots.bidderCount,
      isActive: auctionLots.isActive,
      isReopened: auctionLots.isReopened,
    })
    .from(auctionLots)
    .innerJoin(auctions, eq(auctions.id, auctionLots.auctionId))
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .leftJoin(bidders, eq(bidders.id, auctionLots.winnerBidderId))
    .leftJoin(
      plantLocations,
      eq(plantLocations.id, auctionLots.plantLocationId),
    )
    .leftJoin(
      materialLocations,
      eq(materialLocations.id, auctionLots.materialLocationId),
    )
    .leftJoin(users, eq(users.id, auctionLots.updatedBy))
    .leftJoin(
      auctionLotConfirmationDocuments,
      and(
        eq(auctionLotConfirmationDocuments.auctionId, auctionLots.auctionId),
        eq(auctionLotConfirmationDocuments.bidderId, auctionLots.winnerBidderId),
        eq(auctionLotConfirmationDocuments.isActive, true),
      ),
    )
    .leftJoin(
      lotEmailedByUsers,
      eq(lotEmailedByUsers.id, auctionLotConfirmationDocuments.emailSentBy),
    )
    .leftJoin(
      lotReviewedByUsers,
      eq(lotReviewedByUsers.id, auctionLots.reviewedBy),
    )
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.id, lotId),
        eq(auctionLots.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ? mapLotRow(rows[0]) : null;
}

export async function pgLotTimes(
  auctionId: number,
): Promise<
  Array<{
    lotStartTime: string | null;
    lotEndTime: string | null;
    lotExtendedEndTime: string | null;
  }>
> {
  const rows = await db
    .select({
      lotStartTime: auctionLots.startTime,
      lotEndTime: auctionLots.endTime,
      lotExtendedEndTime: auctionLots.extendedEndTime,
    })
    .from(auctionLots)
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.isActive, true)),
    );
  return rows;
}

/** @deprecated Prefer pgLotTimes */
export async function pgLotEndTimes(
  auctionId: number,
): Promise<Array<{ lotEndTime: string | null }>> {
  const rows = await pgLotTimes(auctionId);
  return rows.map((r) => ({ lotEndTime: r.lotEndTime }));
}

export type PgNoBidLotRow = {
  lotId: number;
  lotNumber: string | null;
  displayOrder: number | null;
  startTime: string | null;
  endTime: string | null;
  quantity: number | null;
  uom: string | null;
  startBidPrice: number | null;
  noBidExtensionCountMax: number | null;
  noBidExtensionCount: number;
  isNoBidExtension: boolean;
  isReopened: boolean;
  noBidExtensionStoppedAt: string | null;
  noBidExtensionStoppedByName: string | null;
};

export async function pgNoBidLots(auctionId: number): Promise<PgNoBidLotRow[]> {
  const rows = await db
    .select({
      lotId: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
      displayOrder: auctionLots.displayOrder,
      startTime: auctionLots.startTime,
      endTime: auctionLots.endTime,
      quantity: auctionLots.quantity,
      uom: uoms.code,
      startBidPrice: auctionLots.startBidPrice,
      noBidExtensionCountMax: auctions.noBidExtensionCountMax,
      noBidExtensionCount: auctionLots.noBidExtensionCount,
      isNoBidExtension: auctionLots.isNoBidExtension,
      isReopened: auctionLots.isReopened,
      noBidExtensionStoppedAt: auctionLots.noBidExtensionStoppedAt,
      noBidExtensionStoppedByName: users.name,
    })
    .from(auctionLots)
    .innerJoin(auctions, eq(auctions.id, auctionLots.auctionId))
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .leftJoin(users, eq(users.id, auctionLots.noBidExtensionStoppedBy))
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.isActive, true),
        eq(auctionLots.bidCount, 0),
      ),
    )
    .orderBy(asc(auctionLots.displayOrder), asc(auctionLots.id));

  return rows.map((r) => ({
    lotId: r.lotId,
    lotNumber: r.lotNumber,
    displayOrder: num(r.displayOrder),
    startTime: r.startTime,
    endTime: r.endTime,
    quantity: num(r.quantity),
    uom: r.uom,
    startBidPrice: num(r.startBidPrice),
    noBidExtensionCountMax: r.noBidExtensionCountMax,
    noBidExtensionCount: r.noBidExtensionCount ?? 0,
    isNoBidExtension: r.isNoBidExtension ?? true,
    isReopened: r.isReopened ?? false,
    noBidExtensionStoppedAt: r.noBidExtensionStoppedAt,
    noBidExtensionStoppedByName: r.noBidExtensionStoppedByName,
  }));
}

export async function pgStopNoBidExtensionAll(
  auctionId: number,
  userId: number,
): Promise<void> {
  // Stop every no-bid lot (the lot flag is the source of truth for per-lot
  // status). Do not flip the auction-level is_no_bid_extension — that remains
  // a settings/create-time flag only.
  await db
    .update(auctionLots)
    .set({
      isNoBidExtension: false,
      noBidExtensionStoppedAt: sql`now()`,
      noBidExtensionStoppedBy: userId,
      updatedBy: userId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.bidCount, 0),
        eq(auctionLots.isActive, true),
      ),
    );
}

export async function pgStopNoBidExtensionLots(
  auctionId: number,
  lotIds: number[],
  userId: number,
): Promise<void> {
  if (lotIds.length === 0) return;
  await db
    .update(auctionLots)
    .set({
      isNoBidExtension: false,
      noBidExtensionStoppedAt: sql`now()`,
      noBidExtensionStoppedBy: userId,
      updatedBy: userId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        inArray(auctionLots.id, lotIds),
        eq(auctionLots.bidCount, 0),
        eq(auctionLots.isActive, true),
      ),
    );
}

/** True when any lot on the auction has at least one bid. */
export async function pgAuctionHasBids(auctionId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: auctionLots.id })
    .from(auctionLots)
    .where(and(eq(auctionLots.auctionId, auctionId), gt(auctionLots.bidCount, 0)))
    .limit(1);
  return !!row;
}

export async function pgLotBidderSummary(auctionId: number) {
  const lots = await pgListLots(auctionId);
  const maps = await db
    .select({
      lotId: auctionLotBidderMaps.lotId,
      bidderId: auctionLotBidderMaps.bidderId,
    })
    .from(auctionLotBidderMaps)
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.isActive, true),
      ),
    );

  return lots.map((lot) => {
    const bidderIds = new Set(
      maps
        .filter((m) => m.lotId === lot.lotId || m.lotId == null)
        .map((m) => m.bidderId),
    );
    return {
      lotId: lot.lotId,
      lotNumber: lot.lotNumber,
      bidderCount: bidderIds.size,
    };
  });
}

/**
 * Active lots with at least one bidder actually attached for bidding
 * (excludes bidder-pool-only entries, which have no `lotId` and hold no EMD).
 */
export async function pgLotsWithAttachedBidders(
  auctionId: number,
): Promise<Array<{ lotId: number; displayOrder: number | null }>> {
  const rows = await db
    .select({
      lotId: auctionLots.id,
      displayOrder: auctionLots.displayOrder,
    })
    .from(auctionLots)
    .innerJoin(
      auctionLotBidderMaps,
      and(
        eq(auctionLotBidderMaps.lotId, auctionLots.id),
        eq(auctionLotBidderMaps.isActive, true),
      ),
    )
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.isActive, true)),
    )
    .groupBy(auctionLots.id, auctionLots.displayOrder);

  return rows.map((r) => ({
    lotId: r.lotId,
    displayOrder: num(r.displayOrder),
  }));
}

export async function pgBidderPool(auctionId: number) {
  const rows = await db
    .select({
      id: auctionLotBidderMaps.id,
      bidderId: auctionLotBidderMaps.bidderId,
      bidderName: bidders.companyName,
      lotId: auctionLotBidderMaps.lotId,
      isActive: auctionLotBidderMaps.isActive,
    })
    .from(auctionLotBidderMaps)
    .leftJoin(bidders, eq(bidders.id, auctionLotBidderMaps.bidderId))
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.isActive, true),
      ),
    )
    .orderBy(asc(auctionLotBidderMaps.id));

  return rows.map((r) => ({
    id: r.id,
    bidderCompId: r.bidderId,
    bidderName: r.bidderName,
    lotId: r.lotId,
    isActive: r.isActive,
  }));
}

export async function pgLotBidderMap(auctionId: number) {
  const lots = await pgListLots(auctionId);
  const maps = await db
    .select({
      lotId: auctionLotBidderMaps.lotId,
      bidderId: auctionLotBidderMaps.bidderId,
      bidderName: bidders.companyName,
      emdReleased: auctionLotBidderMaps.emdReleased,
    })
    .from(auctionLotBidderMaps)
    .leftJoin(bidders, eq(bidders.id, auctionLotBidderMaps.bidderId))
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.isActive, true),
      ),
    )
    .orderBy(asc(bidders.companyName));

  return lots.map((lot) => ({
    lotId: lot.lotId,
    lotNumber: lot.lotNumber,
    displayOrder: lot.displayOrder,
    bidders: dedupeLotBidders(
      maps
        .filter((m) => m.lotId === lot.lotId)
        .map((m) => ({
          bidderCompId: m.bidderId,
          bidderName: m.bidderName,
          emdReleased: m.emdReleased,
        })),
    ),
  }));
}

function dedupeLotBidders(
  bidders: Array<{ bidderCompId: number; bidderName: string | null; emdReleased: boolean }>,
): Array<{ bidderCompId: number; bidderName: string | null; emdReleased: boolean }> {
  const seen = new Set<number>();
  const out: Array<{ bidderCompId: number; bidderName: string | null; emdReleased: boolean }> = [];
  for (const bidder of bidders) {
    if (seen.has(bidder.bidderCompId)) continue;
    seen.add(bidder.bidderCompId);
    out.push(bidder);
  }
  return out;
}

function buildLotBidderMapSearchCondition(
  auctionId: number,
  search: string | undefined,
): SQL | undefined {
  const q = search?.trim();
  if (!q) return undefined;
  const pattern = `%${q}%`;
  // Match UI display-order format (toFixed(3)), not bare cast(numeric as text).
  return or(
    ilike(auctionLots.lotNumber, pattern),
    sql`to_char(${auctionLots.displayOrder}, 'FM9999999990.000') ilike ${pattern}`,
    exists(
      db
        .select({ one: sql`1` })
        .from(auctionLotBidderMaps)
        .leftJoin(bidders, eq(bidders.id, auctionLotBidderMaps.bidderId))
        .where(
          and(
            eq(auctionLotBidderMaps.auctionId, auctionId),
            eq(auctionLotBidderMaps.lotId, auctionLots.id),
            eq(auctionLotBidderMaps.isActive, true),
            ilike(bidders.companyName, pattern),
          ),
        ),
    ),
  );
}

function buildLotBidderMapOrderBy(
  sortBy: AuctionLotBidderMapListSortBy | undefined,
  sortOrder: "asc" | "desc" | undefined,
) {
  const descOrder = sortOrder === "desc";
  const col =
    sortBy === "lotNumber" ? auctionLots.lotNumber : auctionLots.displayOrder;
  return descOrder
    ? [desc(col), asc(auctionLots.id)]
    : [asc(col), asc(auctionLots.id)];
}

export async function pgLotBidderMapPaginated(
  auctionId: number,
  opts: AuctionLotBidderMapListParams = {},
) {
  const { page, pageSize, offset } = clampPagination(
    opts.page ?? 1,
    opts.pageSize ?? 10,
  );
  const whereExpr = and(
    eq(auctionLots.auctionId, auctionId),
    eq(auctionLots.isActive, true),
    buildLotBidderMapSearchCondition(auctionId, opts.search),
  );
  const orderBy = buildLotBidderMapOrderBy(opts.sortBy, opts.sortOrder);

  const [countRow] = await db
    .select({ total: count() })
    .from(auctionLots)
    .where(whereExpr);

  const lotRows = await db
    .select({
      lotId: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
      displayOrder: auctionLots.displayOrder,
    })
    .from(auctionLots)
    .where(whereExpr)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(offset);

  const lotIds = lotRows.map((l) => l.lotId);
  const maps =
    lotIds.length === 0
      ? []
      : await db
          .select({
            lotId: auctionLotBidderMaps.lotId,
            bidderId: auctionLotBidderMaps.bidderId,
            bidderName: bidders.companyName,
            emdReleased: auctionLotBidderMaps.emdReleased,
          })
          .from(auctionLotBidderMaps)
          .leftJoin(bidders, eq(bidders.id, auctionLotBidderMaps.bidderId))
          .where(
            and(
              eq(auctionLotBidderMaps.auctionId, auctionId),
              eq(auctionLotBidderMaps.isActive, true),
              inArray(auctionLotBidderMaps.lotId, lotIds),
            ),
          )
          .orderBy(asc(bidders.companyName));

  const items = lotRows.map((lot) => ({
    lotId: lot.lotId,
    lotNumber: lot.lotNumber,
    displayOrder: num(lot.displayOrder),
    bidders: dedupeLotBidders(
      maps
        .filter((m) => m.lotId === lot.lotId)
        .map((m) => ({
          bidderCompId: m.bidderId,
          bidderName: m.bidderName,
          emdReleased: m.emdReleased,
        })),
    ),
  }));

  return {
    items,
    total: Number(countRow?.total ?? 0),
    page,
    pageSize,
  };
}

export type PgLotBidderMapExportRow = {
  bidderId: number;
  bidderName: string;
  displayOrder: number;
  isEmdWithClient: boolean;
};

/** Every active bidder-lot attachment for an auction, for the re-importable export. */
export async function pgLotBidderMapForExport(
  auctionId: number,
): Promise<PgLotBidderMapExportRow[]> {
  const rows = await db
    .select({
      bidderId: auctionLotBidderMaps.bidderId,
      bidderName: bidders.companyName,
      displayOrder: auctionLots.displayOrder,
      isEmdWithClient: auctionLotBidderMaps.isEmdWithClient,
    })
    .from(auctionLotBidderMaps)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionLotBidderMaps.lotId))
    .leftJoin(bidders, eq(bidders.id, auctionLotBidderMaps.bidderId))
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.isActive, true),
        eq(auctionLots.isActive, true),
      ),
    )
    .orderBy(asc(bidders.companyName), asc(auctionLots.displayOrder));

  return rows
    .map((r) => ({
      bidderId: r.bidderId,
      bidderName: r.bidderName ?? "",
      displayOrder: num(r.displayOrder),
      isEmdWithClient: r.isEmdWithClient ?? false,
    }))
    .filter((r): r is PgLotBidderMapExportRow => r.displayOrder != null);
}

export async function pgLotMappedBidders(auctionId: number, lotId: number) {
  const rows = await db
    .select({
      bidderId: auctionLotBidderMaps.bidderId,
      bidderName: bidders.companyName,
    })
    .from(auctionLotBidderMaps)
    .leftJoin(bidders, eq(bidders.id, auctionLotBidderMaps.bidderId))
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.lotId, lotId),
        eq(auctionLotBidderMaps.isActive, true),
      ),
    );

  return dedupeLotBidders(
    rows.map((r) => ({
      bidderCompId: r.bidderId,
      bidderName: r.bidderName,
      emdReleased: false,
    })),
  ).map(({ bidderCompId, bidderName }) => ({ bidderCompId, bidderName }));
}

/** Client-mapped bidders eligible for settlement winner correction. */
export async function pgCorrectionWinnerCandidates(
  clientId: number,
  auctionId: number,
  lotId: number,
): Promise<
  Array<{
    bidderCompId: number;
    bidderName: string | null;
    mappedToLot: boolean;
  }>
> {
  const [clientRow] = await db
    .select({ bidders: clients.bidders })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  const candidateIds = [...new Set(clientRow?.bidders ?? [])].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (candidateIds.length === 0) return [];

  const blocked = await blockedBidderIdsForClient(clientId, candidateIds);
  const eligibleIds = candidateIds.filter((id) => !blocked.has(id));
  if (eligibleIds.length === 0) return [];

  const [bidderRows, onLotRows] = await Promise.all([
    db
      .select({
        bidderId: bidders.id,
        bidderName: bidders.companyName,
        isActive: bidders.isActive,
      })
      .from(bidders)
      .where(and(inArray(bidders.id, eligibleIds), eq(bidders.isActive, true)))
      .orderBy(asc(bidders.companyName)),
    db
      .select({ bidderId: auctionLotBidderMaps.bidderId })
      .from(auctionLotBidderMaps)
      .where(
        and(
          eq(auctionLotBidderMaps.auctionId, auctionId),
          eq(auctionLotBidderMaps.lotId, lotId),
          eq(auctionLotBidderMaps.isActive, true),
          inArray(auctionLotBidderMaps.bidderId, eligibleIds),
        ),
      ),
  ]);

  const onLot = new Set(onLotRows.map((r) => r.bidderId));
  return bidderRows.map((r) => ({
    bidderCompId: r.bidderId,
    bidderName: r.bidderName,
    mappedToLot: onLot.has(r.bidderId),
  }));
}

export async function pgLotItems(
  clientId: number,
  auctionId: number,
  lotId: number,
) {
  const rows = await db
    .select({
      id: auctionLotItems.id,
      itemId: auctionLotItems.itemId,
      materialName: auctionLotItems.materialName,
      materialDescription: auctionLotItems.materialDescription,
      quantity: auctionLotItems.quantity,
      uomId: auctionLots.uomId,
      uomCode: uoms.code,
      benchmarkMaterialLocationId: auctionLotItems.benchmarkMaterialLocationId,
      benchmarkMaterial: benchmarkMaterials.name,
      benchmarkLocation: benchmarkLocations.name,
      itemName: items.name,
    })
    .from(auctionLotItems)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionLotItems.lotId))
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .leftJoin(items, eq(items.id, auctionLotItems.itemId))
    .leftJoin(
      benchmarkMaterialLocations,
      eq(
        benchmarkMaterialLocations.id,
        auctionLotItems.benchmarkMaterialLocationId,
      ),
    )
    .leftJoin(benchmarkMaterials, eq(benchmarkMaterials.id, benchmarkMaterialLocations.materialId))
    .leftJoin(benchmarkLocations, eq(benchmarkLocations.id, benchmarkMaterialLocations.locationId))
    .where(
      and(
        eq(auctionLotItems.clientId, clientId),
        eq(auctionLotItems.auctionId, auctionId),
        eq(auctionLotItems.lotId, lotId),
        eq(auctionLotItems.isActive, true),
      ),
    )
    .orderBy(asc(auctionLotItems.id));

  return rows.map((r) => ({
    id: r.id,
    itemId: r.itemId ?? 0,
    itemName: r.itemName ?? r.materialName,
    materialName: r.materialName,
    materialDescription: r.materialDescription,
    quantity: num(r.quantity),
    uomId: r.uomId,
    uom: r.uomCode,
    benchmarkMaterialLocationId: r.benchmarkMaterialLocationId,
    benchmarkMaterial:
      r.benchmarkMaterial && r.benchmarkLocation
        ? `${r.benchmarkMaterial}@@${r.benchmarkLocation}`
        : null,
  }));
}

export type PgLotExportRow = {
  lotId: number;
  displayOrder: number | null;
  lotNumber: string | null;
  materialLiftingDays: number | null;
  plantLocationName: string | null;
  materialLocationName: string | null;
  startBidPrice: number | null;
  bidIncrement: number | null;
  bidLimit: number | null;
  quantity: number | null;
  uomCode: string | null;
  lotStartTime: string | null;
  lotEndTime: string | null;
  itemId: number | null;
  itemName: string | null;
  materialName: string | null;
  materialDescription: string | null;
  benchmarkMaterial: string | null;
  gstPercentage: number | null;
  tcsPercentage: number | null;
  loadingScope: string | null;
  remark: string | null;
};

/** All active lots + their primary active item, for the "Export Lots" download. */
export async function pgListLotsForExport(
  auctionId: number,
): Promise<PgLotExportRow[]> {
  const rows = await db
    .select({
      lotId: auctionLots.id,
      displayOrder: auctionLots.displayOrder,
      lotNumber: auctionLots.lotNumber,
      materialLiftingDays: auctionLots.materialLiftingDays,
      plantLocationName: plantLocations.name,
      materialLocationName: materialLocations.name,
      startBidPrice: auctionLots.startBidPrice,
      bidIncrement: auctionLots.bidIncrement,
      bidLimit: auctionLots.bidLimit,
      quantity: auctionLotItems.quantity,
      uomCode: uoms.code,
      lotStartTime: auctionLots.startTime,
      lotEndTime: auctionLots.endTime,
      itemId: auctionLotItems.itemId,
      itemName: items.name,
      materialName: auctionLotItems.materialName,
      materialDescription: auctionLotItems.materialDescription,
      benchmarkMaterial: benchmarkMaterials.name,
      benchmarkLocation: benchmarkLocations.name,
      gstPercentage: auctionLots.gstPercentage,
      tcsPercentage: auctionLots.tcsPercentage,
      loadingScope: auctionLots.loadingScope,
      remark: auctionLots.remark,
    })
    .from(auctionLots)
    .leftJoin(
      plantLocations,
      eq(plantLocations.id, auctionLots.plantLocationId),
    )
    .leftJoin(
      materialLocations,
      eq(materialLocations.id, auctionLots.materialLocationId),
    )
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .leftJoin(
      auctionLotItems,
      and(
        eq(auctionLotItems.lotId, auctionLots.id),
        eq(auctionLotItems.isActive, true),
      ),
    )
    .leftJoin(items, eq(items.id, auctionLotItems.itemId))
    .leftJoin(
      benchmarkMaterialLocations,
      eq(
        benchmarkMaterialLocations.id,
        auctionLotItems.benchmarkMaterialLocationId,
      ),
    )
    .leftJoin(
      benchmarkMaterials,
      eq(benchmarkMaterials.id, benchmarkMaterialLocations.materialId),
    )
    .leftJoin(
      benchmarkLocations,
      eq(benchmarkLocations.id, benchmarkMaterialLocations.locationId),
    )
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.isActive, true)),
    )
    .orderBy(asc(auctionLots.displayOrder), asc(auctionLots.id));

  return rows.map((r) => ({
    lotId: r.lotId,
    displayOrder: num(r.displayOrder),
    lotNumber: r.lotNumber,
    materialLiftingDays: r.materialLiftingDays,
    plantLocationName: r.plantLocationName,
    materialLocationName: r.materialLocationName,
    startBidPrice: num(r.startBidPrice),
    bidIncrement: num(r.bidIncrement),
    bidLimit: num(r.bidLimit),
    quantity: num(r.quantity),
    uomCode: r.uomCode,
    lotStartTime: r.lotStartTime,
    lotEndTime: r.lotEndTime,
    itemId: r.itemId,
    itemName: r.itemName,
    materialName: r.materialName,
    materialDescription: r.materialDescription,
    benchmarkMaterial:
      r.benchmarkMaterial && r.benchmarkLocation
        ? `${r.benchmarkMaterial}@@${r.benchmarkLocation}`
        : null,
    gstPercentage: num(r.gstPercentage),
    tcsPercentage: num(r.tcsPercentage),
    loadingScope: r.loadingScope,
    remark: r.remark,
  }));
}

export type PgEmdRangeRow = {
  lotEmdId: number;
  lotDisplayOrderFrom: number;
  lotDisplayOrderTo: number;
  emd: number;
  displayOrder: number | null;
};

export type PgReplaceEmdRangeInput = {
  displayOrder?: number | null;
  lotDisplayOrderFrom: number;
  lotDisplayOrderTo: number;
  emd: number;
};

export async function pgEmdRanges(auctionId: number): Promise<PgEmdRangeRow[]> {
  const rows = await db
    .select()
    .from(auctionLotEmdRanges)
    .where(eq(auctionLotEmdRanges.auctionId, auctionId))
    .orderBy(
      asc(auctionLotEmdRanges.displayOrder),
      asc(auctionLotEmdRanges.id),
    );

  return rows.map((r) => ({
    lotEmdId: r.id,
    lotDisplayOrderFrom: Number(r.lotDisplayOrderFrom),
    lotDisplayOrderTo: Number(r.lotDisplayOrderTo),
    emd: Number(r.emdAmount),
    displayOrder: r.displayOrder,
  }));
}

export async function pgInsertEmdRange(
  auctionId: number,
  body: {
    lotDisplayOrderFrom: number;
    lotDisplayOrderTo: number;
    emd: number;
  },
  userId: number,
) {
  const maxId = await db
    .select({ id: sql<number>`COALESCE(MAX(${auctionLotEmdRanges.id}), 0)` })
    .from(auctionLotEmdRanges);
  const nextId = Number(maxId[0]?.id ?? 0) + 1;
  const now = formatUtcNow();

  await db.insert(auctionLotEmdRanges).values({
    id: nextId,
    auctionId,
    lotDisplayOrderFrom: String(body.lotDisplayOrderFrom),
    lotDisplayOrderTo: String(body.lotDisplayOrderTo),
    emdAmount: String(body.emd),
    createdAt: now,
    createdBy: userId,
  });
}

export async function pgDeleteEmdRange(auctionId: number, lotEmdId: number) {
  await db
    .delete(auctionLotEmdRanges)
    .where(
      and(
        eq(auctionLotEmdRanges.auctionId, auctionId),
        eq(auctionLotEmdRanges.id, lotEmdId),
      ),
    );
}

export async function pgActiveLotDisplayOrders(auctionId: number) {
  const lots = await db
    .select({
      lotId: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
      displayOrder: auctionLots.displayOrder,
    })
    .from(auctionLots)
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.isActive, true)),
    );

  return lots.map((l) => ({
    lotId: l.lotId,
    lotNumber: l.lotNumber,
    displayOrder: l.displayOrder != null ? Number(l.displayOrder) : null,
  }));
}

export async function pgReplaceEmdRanges(
  auctionId: number,
  consolidatedEmd: number,
  ranges: PgReplaceEmdRangeInput[],
  userId: number,
): Promise<{ ranges: PgEmdRangeRow[]; consolidatedEmd: number }> {
  const coverageLots = await pgActiveLotDisplayOrders(auctionId);
  const check = assertSaveable(coverageLots, ranges);
  if (!check.ok) {
    throw new Error(check.message ?? AuctionsValidationMessages.EMD_RANGES_INVALID);
  }

  for (const r of ranges) {
    if (!(r.emd > 0)) {
      throw new Error(AuctionsValidationMessages.EMD_RANGE_AMOUNT_MUST_BE_POSITIVE);
    }
    if (r.lotDisplayOrderTo < r.lotDisplayOrderFrom) {
      throw new Error(AuctionsValidationMessages.EMD_RANGE_TO_GTE_FROM);
    }
  }

  const totals = checkEmdTotals({
    rangeCount: ranges.length,
    rangeEmdSum: sumRangeEmd(ranges.map((r) => r.emd)),
    consolidatedEmd,
  });
  if (!totals.ok) {
    throw new Error(
      totals.message ?? AuctionsValidationMessages.EMD_RANGES_INVALID,
    );
  }

  const now = formatUtcNow();

  return db.transaction(async (tx) => {
    await tx
      .update(auctions)
      .set({
        consolidatedEmdAmount: String(consolidatedEmd),
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(auctions.id, auctionId));

    await tx
      .delete(auctionLotEmdRanges)
      .where(eq(auctionLotEmdRanges.auctionId, auctionId));

    const [maxRow] = await tx
      .select({
        maxId: sql<number>`coalesce(max(${auctionLotEmdRanges.id}), 0)`,
      })
      .from(auctionLotEmdRanges);
    let nextId = Number(maxRow?.maxId ?? 0) + 1;

    const inserted: PgEmdRangeRow[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      const displayOrder = r.displayOrder ?? i + 1;
      const id = nextId++;
      await tx.insert(auctionLotEmdRanges).values({
        id,
        auctionId,
        lotDisplayOrderFrom: String(r.lotDisplayOrderFrom),
        lotDisplayOrderTo: String(r.lotDisplayOrderTo),
        emdAmount: String(r.emd),
        displayOrder,
        createdAt: now,
        createdBy: userId,
      });
      inserted.push({
        lotEmdId: id,
        lotDisplayOrderFrom: r.lotDisplayOrderFrom,
        lotDisplayOrderTo: r.lotDisplayOrderTo,
        emd: r.emd,
        displayOrder,
      });
    }

    return { ranges: inserted, consolidatedEmd };
  });
}

export async function pgListAuctionDocumentTypes() {
  const rows = await db
    .select({
      documentTypeId: auctionDocumentTypes.id,
      name: auctionDocumentTypes.name,
      fileNamePrefix: auctionDocumentTypes.fileNamePrefix,
    })
    .from(auctionDocumentTypes)
    .where(eq(auctionDocumentTypes.isActive, true))
    .orderBy(asc(auctionDocumentTypes.id));

  return {
    documentTypes: rows,
    allowedExtensions: ["pdf", "docx"] as string[],
  };
}

type AuctionDocumentRow = {
  id: number;
  documentTypeId: number;
  documentTypeName: string;
  fileName: string;
  s3Key: string;
  isActive: boolean;
  createDatetime: string;
  uploadedByName: string | null;
};

async function mapAuctionDocumentRows(rows: AuctionDocumentRow[]) {
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      documentTypeId: r.documentTypeId,
      documentTypeName: r.documentTypeName,
      fileName: r.fileName,
      fileSize: null as number | null,
      isActive: r.isActive,
      createDatetime: r.createDatetime,
      uploadedByName: r.uploadedByName ?? null,
      s3Key: r.s3Key,
      downloadUrl: await getSignedDownloadUrl(r.s3Key),
    })),
  );
}

const auctionDocumentSelect = {
  id: auctionDocuments.id,
  documentTypeId: auctionDocuments.documentTypeId,
  documentTypeName: auctionDocumentTypes.name,
  fileName: auctionDocuments.fileName,
  s3Key: auctionDocuments.s3Key,
  isActive: auctionDocuments.isActive,
  createDatetime: auctionDocuments.createdAt,
  uploadedByName: users.name,
};

export async function pgListAuctionDocuments(auctionId: number) {
  const rows = await db
    .select(auctionDocumentSelect)
    .from(auctionDocuments)
    .innerJoin(
      auctionDocumentTypes,
      eq(auctionDocuments.documentTypeId, auctionDocumentTypes.id),
    )
    .leftJoin(users, eq(users.id, auctionDocuments.createdBy))
    .where(eq(auctionDocuments.auctionId, auctionId))
    .orderBy(
      asc(auctionDocuments.documentTypeId),
      desc(auctionDocuments.createdAt),
    );

  return mapAuctionDocumentRows(rows);
}

export async function pgListAuctionDocumentsPaginated(
  auctionId: number,
  opts: AuctionDocumentsListParams,
) {
  const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
  const search = opts.search?.trim();

  const conditions = [eq(auctionDocuments.auctionId, auctionId)];
  if (search) {
    conditions.push(
      or(
        ilike(auctionDocuments.fileName, `%${search}%`),
        ilike(auctionDocumentTypes.name, `%${search}%`),
        ilike(users.name, `%${search}%`),
      )!,
    );
  }
  const whereExpr = and(...conditions);

  const sortBy = opts.sortBy ?? "createDatetime";
  const descOrder = (opts.sortOrder ?? "desc") === "desc";
  const sortCol =
    sortBy === "fileName"
      ? auctionDocuments.fileName
      : sortBy === "documentTypeName"
        ? auctionDocumentTypes.name
        : sortBy === "uploadedByName"
          ? users.name
          : auctionDocuments.createdAt;
  const orderBy = descOrder
    ? [desc(sortCol), desc(auctionDocuments.id)]
    : [asc(sortCol), asc(auctionDocuments.id)];

  const baseFrom = () =>
    db
      .select(auctionDocumentSelect)
      .from(auctionDocuments)
      .innerJoin(
        auctionDocumentTypes,
        eq(auctionDocuments.documentTypeId, auctionDocumentTypes.id),
      )
      .leftJoin(users, eq(users.id, auctionDocuments.createdBy))
      .$dynamic();

  const countFrom = () =>
    db
      .select({ total: count() })
      .from(auctionDocuments)
      .innerJoin(
        auctionDocumentTypes,
        eq(auctionDocuments.documentTypeId, auctionDocumentTypes.id),
      )
      .leftJoin(users, eq(users.id, auctionDocuments.createdBy))
      .$dynamic();

  const [[countRow], rows] = await Promise.all([
    whereExpr ? countFrom().where(whereExpr) : countFrom(),
    (whereExpr ? baseFrom().where(whereExpr) : baseFrom())
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset),
  ]);

  return {
    items: await mapAuctionDocumentRows(rows),
    total: Number(countRow?.total ?? 0),
    page,
    pageSize,
  };
}

export async function pgAuctionStats(auctionId: number) {
  const lots = await pgListLots(auctionId);
  const lotsWithBidders = await pgLotBidderSummary(auctionId);
  const mappedCount = lotsWithBidders.filter((l) => l.bidderCount > 0).length;
  const documents = await pgListAuctionDocuments(auctionId);
  const emdRanges = await pgEmdRanges(auctionId);
  const pool = await pgBidderPool(auctionId);

  const totalQty = lots.reduce((s, l) => s + (l.quantity ?? 0), 0);
  const soldQty = lots.reduce(
    (s, l) => s + (l.winingAmount != null ? (l.quantity ?? 0) : 0),
    0,
  );

  const catalogue = documents.find(
    (d) => d.documentTypeId === AUCTION_DOCUMENT_TYPE_CATALOGUE,
  );
  const tnc = documents.find(
    (d) => d.documentTypeId === AUCTION_DOCUMENT_TYPE_TNC,
  );

  const lotsApproved = lots.filter((l) => l.isApproved === true).length;

  return {
    lotsTotal: lots.length,
    lotsApproved,
    lotsPreview: lots.slice(0, 10),
    lotsWithBidders: mappedCount,
    catalogueUploaded: catalogue != null,
    currentCatalogue: catalogue
      ? {
          name: catalogue.fileName,
          uploadedAt: catalogue.createDatetime,
          downloadUrl: catalogue.downloadUrl,
        }
      : null,
    tncUploaded: tnc != null,
    currentTnc: tnc
      ? {
          name: tnc.fileName,
          uploadedAt: tnc.createDatetime,
          downloadUrl: tnc.downloadUrl,
        }
      : null,
    lotEmdSet: emdRanges.length > 0,
    lotEmdCount: emdRanges.length,
    biddersMapped: mappedCount > 0,
    bidderCount: new Set(pool.map((p) => p.bidderCompId)).size,
    totalQty: totalQty || null,
    soldQty: soldQty || null,
    uom: lots[0]?.uom ?? null,
  };
}

export async function pgWinnerName(
  winnerBidderId: number | null,
): Promise<string | null> {
  if (winnerBidderId == null) return null;
  const rows = await db
    .select({ name: bidders.companyName })
    .from(bidders)
    .where(eq(bidders.id, winnerBidderId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/** Stamp review time on approve/reject; clear on pending. */
function lotApprovalStamp(
  isApproved: boolean | null,
  userId: number,
  now: string,
): {
  isApproved: boolean | null;
  reviewedAt: string | null;
  reviewedBy: number | null;
} {
  if (isApproved === true || isApproved === false) {
    return { isApproved, reviewedAt: now, reviewedBy: userId };
  }
  return { isApproved: null, reviewedAt: null, reviewedBy: null };
}

export async function pgApproveLots(
  auctionId: number,
  lotIds: number[] | "all",
  userId: number,
) {
  const now = formatUtcNow();
  const set = {
    ...lotApprovalStamp(true, userId, now),
    updatedAt: now,
    updatedBy: userId,
  };
  if (lotIds === "all") {
    await db
      .update(auctionLots)
      .set(set)
      .where(
        and(
          eq(auctionLots.auctionId, auctionId),
          eq(auctionLots.isActive, true),
        ),
      );
    return;
  }

  if (lotIds.length === 0) return;

  await db
    .update(auctionLots)
    .set(set)
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        inArray(auctionLots.id, lotIds),
      ),
    );
}

export async function pgRejectLots(
  auctionId: number,
  lotIds: number[] | "all",
  userId: number,
) {
  const now = formatUtcNow();
  const set = {
    ...lotApprovalStamp(false, userId, now),
    updatedAt: now,
    updatedBy: userId,
  };
  if (lotIds === "all") {
    await db
      .update(auctionLots)
      .set(set)
      .where(
        and(
          eq(auctionLots.auctionId, auctionId),
          eq(auctionLots.isActive, true),
        ),
      );
    return;
  }

  if (lotIds.length === 0) return;
  await db
    .update(auctionLots)
    .set(set)
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        inArray(auctionLots.id, lotIds),
      ),
    );
}

export type SaveLotApprovalEntry = {
  lotId: number;
  isApproved?: boolean | null;
  remark?: string | null;
};

/**
 * Persist per-lot approval decisions and remarks in one batch.
 * Status and remark stay editable. Review stamps update on approve/reject only.
 */
export async function pgSaveLotApprovals(
  auctionId: number,
  entries: SaveLotApprovalEntry[],
  userId: number,
) {
  if (entries.length === 0) return;
  const now = formatUtcNow();

  for (const entry of entries) {
    const set: {
      updatedAt: string;
      updatedBy: number;
      remark?: string | null;
      isApproved?: boolean | null;
      reviewedAt?: string | null;
      reviewedBy?: number | null;
    } = { updatedAt: now, updatedBy: userId };

    if (entry.remark !== undefined) {
      const trimmed = entry.remark?.trim();
      set.remark = trimmed ? trimmed : null;
    }

    if (entry.isApproved !== undefined) {
      Object.assign(set, lotApprovalStamp(entry.isApproved, userId, now));
    }

    await db
      .update(auctionLots)
      .set(set)
      .where(
        and(
          eq(auctionLots.auctionId, auctionId),
          eq(auctionLots.id, entry.lotId),
          eq(auctionLots.isActive, true),
        ),
      );
  }
}

export async function pgPatchLot(
  auctionId: number,
  lotId: number,
  body: AuctionLotWriteBody,
  userId: number,
) {
  const clientId = await pgGetAuctionClientId(auctionId);
  if (!clientId) throw new Error(AuctionsErrorMessages.AUCTION_NOT_FOUND);

  const [existingLot] = await db
    .select({
      plantLocationId: auctionLots.plantLocationId,
      materialLocationId: auctionLots.materialLocationId,
      uomId: auctionLots.uomId,
      startTime: auctionLots.startTime,
      bidCount: auctionLots.bidCount,
      startBidPrice: auctionLots.startBidPrice,
    })
    .from(auctionLots)
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.id, lotId),
        eq(auctionLots.isActive, true),
      ),
    )
    .limit(1);
  if (!existingLot) throw new Error(AuctionsErrorMessages.LOT_NOT_FOUND);

  if (
    existingLot.bidCount > 0 &&
    body.lotStartTime.substring(0, 5) !== (existingLot.startTime ?? "").substring(0, 5)
  ) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.LOT_START_TIME_NOT_EDITABLE_WITH_BIDS,
      {
        lotStartTime: [
          AuctionsValidationMessages.LOT_START_TIME_NOT_EDITABLE_WITH_BIDS,
        ],
      },
    );
  }

  if (
    existingLot.bidCount > 0 &&
    Number(body.startBidPrice) !== Number(existingLot.startBidPrice)
  ) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.START_BID_NOT_EDITABLE_WITH_BIDS,
      {
        startBidPrice: [
          AuctionsValidationMessages.START_BID_NOT_EDITABLE_WITH_BIDS,
        ],
      },
    );
  }

  const existingDisplayOrders = await pgLoadExistingDisplayOrderKeys(
    auctionId,
    { excludeLotId: lotId },
  );
  assertDisplayOrderAvailable(existingDisplayOrders, body.displayOrder);

  const existingLotNumbers = await pgLoadExistingLotNumberKeys(auctionId, {
    excludeLotId: lotId,
  });
  if (existingLotNumbers.has(normalizeLotNumberKey(body.lotNumber))) {
    throw new Error(AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS);
  }

  const [existingItem] = await db
    .select({
      itemId: auctionLotItems.itemId,
      benchmarkMaterialLocationId: auctionLotItems.benchmarkMaterialLocationId,
    })
    .from(auctionLotItems)
    .where(
      and(
        eq(auctionLotItems.auctionId, auctionId),
        eq(auctionLotItems.lotId, lotId),
        eq(auctionLotItems.isActive, true),
      ),
    )
    .orderBy(asc(auctionLotItems.id))
    .limit(1);

  const existingMasters: LotWriteMasterExisting = {
    plantLocationId: existingLot.plantLocationId,
    materialLocationId: existingLot.materialLocationId,
    itemId: existingItem?.itemId ?? null,
    benchmarkMaterialLocationId:
      existingItem?.benchmarkMaterialLocationId ?? null,
    uomId: existingLot.uomId,
  };

  await assertLotWriteMasters(clientId, body, existingMasters);

  const uomId = await pgResolveUomId(body.uomCode, {
    allowInactiveId: existingMasters.uomId,
  });
  if (!uomId) {
    throw new Error(AuctionsValidationMessages.UOM_CODE_UNKNOWN(body.uomCode));
  }

  const now = formatUtcNow();

  await db
    .update(auctionLots)
    .set({
      lotNumber: body.lotNumber.trim(),
      materialLiftingDays: body.materialLiftingDays ?? null,
      plantLocationId: body.plantLocationId,
      materialLocationId: body.materialLocationId ?? null,
      gstPercentage: String(body.gstPercentage),
      tcsPercentage: String(body.tcsPercentage),
      startBidPrice: String(body.startBidPrice),
      bidLimit: String(body.bidLimit),
      bidIncrement: String(body.bidIncrement),
      startTime: body.lotStartTime,
      endTime: body.lotEndTime,
      loadingScope: body.loadingScope,
      displayOrder: String(body.displayOrder),
      remark: body.remark.trim(),
      quantity: String(body.quantity),
      uomId,
      liveRev: sql`live_rev + 1`,
      updatedAt: now,
      updatedBy: userId,
    })
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.id, lotId)),
    );

  const existingItems = await db
    .select({ id: auctionLotItems.id })
    .from(auctionLotItems)
    .where(
      and(
        eq(auctionLotItems.auctionId, auctionId),
        eq(auctionLotItems.lotId, lotId),
        eq(auctionLotItems.isActive, true),
      ),
    )
    .orderBy(asc(auctionLotItems.id))
    .limit(1);

  if (existingItems[0]) {
    await db
      .update(auctionLotItems)
      .set({
        itemId: body.itemId,
        quantity: String(body.quantity),
        benchmarkMaterialLocationId: body.benchmarkMaterialLocationId ?? null,
        materialName: body.materialName.trim(),
        materialDescription: body.materialDescription ?? null,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(auctionLotItems.id, existingItems[0].id));
  } else {
    const nextItemId = await pgNextLotItemId();
    await db.insert(auctionLotItems).values({
      id: nextItemId,
      clientId,
      auctionId,
      lotId,
      itemId: body.itemId,
      quantity: String(body.quantity),
      benchmarkMaterialLocationId: body.benchmarkMaterialLocationId ?? null,
      materialName: body.materialName.trim(),
      materialDescription: body.materialDescription ?? null,
      isActive: true,
      createdAt: now,
      createdBy: userId,
    });
  }

  await pgUnionClientMaterialsFromItemIds(db, clientId, [body.itemId], userId);
}

export async function pgRemoveBidderPoolEntry(
  auctionId: number,
  mapId: number,
) {
  await db
    .update(auctionLotBidderMaps)
    .set({ isActive: false, updatedAt: formatUtcNow() })
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.id, mapId),
      ),
    );
}

/** Single-lot `reopen_lot` goes through `pgReopenLots` (see AuctionsService). */
export async function pgApplyLotCorrection(
  auctionId: number,
  lotId: number,
  body: Exclude<LotCorrectionBody, { type: "reopen_lot" }>,
  removedByUserId: number,
) {
  const now = formatUtcNow();

  // Bid-removal corrections. Mark matching bid logs as removed (audit), then
  // delete from the bid ledger, retire every standing proxy on the lot, and
  // rebuild the lot's denormalized winning amount and bid counters from whatever remains.
  // Proxies must go: leaving them armed means the next bid re-runs settlement
  // and the auto-bidders immediately recreate the rows that were just removed.
  if (body.type === "remove_all_bids" || body.type === "remove_winning_bid") {
    await db.transaction(async (tx) => {
      // Lock the lot so a concurrent live bid can't interleave with the delete
      // and the recompute below.
      const lotRows = await tx.execute<{ id: number }>(sql`
        SELECT id FROM auction_lots
        WHERE id = ${lotId} AND auction_id = ${auctionId} AND is_active = true
        FOR UPDATE
      `);
      if (lotRows.rows.length === 0) return;

      const typeRes = await tx.execute<{ auction_type: string | null }>(sql`
        SELECT auction_type FROM auctions WHERE auction_id = ${auctionId} LIMIT 1
      `);
      const amountOrder =
        typeRes.rows[0]?.auction_type === "reverse" ? sql`ASC` : sql`DESC`;

      if (body.type === "remove_all_bids") {
        const existingBids = await tx.execute<{ id: number }>(sql`
          SELECT id FROM auction_bids WHERE lot_id = ${lotId} LIMIT 1
        `);
        if (existingBids.rows.length === 0) {
          throw new AuctionValidationError(
            AuctionsValidationMessages.NO_BIDS_ON_LOT,
          );
        }
        await tx.execute(sql`
          UPDATE auction_bid_logs
          SET is_removed = true,
              removed_at = ${now}::timestamptz,
              removed_by = ${removedByUserId}
          WHERE lot_id = ${lotId}
            AND is_accepted = true
            AND is_removed = false
        `);
        await tx.execute(sql`DELETE FROM auction_bids WHERE lot_id = ${lotId}`);
      } else {
        const winningBidRes = await tx.execute<{
          id: number;
          bidder_id: number;
          amount: string;
        }>(sql`
          SELECT id, bidder_id, amount
          FROM auction_bids
          WHERE lot_id = ${lotId}
          ORDER BY amount ${amountOrder}, COALESCE(committed_at, created_at) ASC, id ASC
          LIMIT 1
        `);
        const winningBid = winningBidRes.rows[0];
        if (!winningBid) {
          throw new AuctionValidationError(
            AuctionsValidationMessages.NO_BIDS_ON_LOT,
          );
        }
        if (winningBid.bidder_id !== body.bidderId) {
          throw new AuctionValidationError(
            AuctionsValidationMessages.WINNING_BID_BIDDER_MISMATCH,
            {
              bidderId: [
                AuctionsValidationMessages.WINNING_BID_BIDDER_MISMATCH,
              ],
            },
          );
        }

        // Mark the matching accepted log (same bidder + amount) before delete.
        // On ties, void the newest not-yet-removed accepted attempt.
        await tx.execute(sql`
          UPDATE auction_bid_logs
          SET is_removed = true,
              removed_at = ${now}::timestamptz,
              removed_by = ${removedByUserId}
          WHERE id = (
            SELECT id FROM auction_bid_logs
            WHERE lot_id = ${lotId}
              AND bidder_id = ${winningBid.bidder_id}
              AND amount = ${winningBid.amount}::numeric
              AND is_accepted = true
              AND is_removed = false
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
        `);

        await tx.execute(sql`
          DELETE FROM auction_bids WHERE id = ${winningBid.id}
        `);
      }

      await tx.execute(sql`
        UPDATE auction_proxy_bids
        SET is_active = false, updated_at = ${now}::timestamp
        WHERE lot_id = ${lotId} AND is_active = true
      `);

      // Rebuild winning amount (best amount, earliest on a tie) and the counters. Every
      // subquery yields NULL / 0 / '{}' on an emptied ledger, which resets the
      // lot to its no-bids state.
      await tx.execute(sql`
        WITH top AS (
          SELECT amount, bidder_id, user_id
          FROM auction_bids
          WHERE lot_id = ${lotId}
          ORDER BY amount ${amountOrder}, COALESCE(committed_at, created_at) ASC, id ASC
          LIMIT 1
        ), agg AS (
          SELECT count(*)::int AS bid_count,
                 count(DISTINCT bidder_id)::int AS bidder_count,
                 COALESCE(array_agg(DISTINCT bidder_id), '{}'::int[]) AS bidder_ids
          FROM auction_bids
          WHERE lot_id = ${lotId}
        )
        UPDATE auction_lots l SET
          winning_amount   = (SELECT amount FROM top),
          winner_bidder_id = (SELECT bidder_id FROM top),
          winner_user_id   = (SELECT user_id FROM top),
          -- The only write that lowers winning amount / bid_count. Bumping the revision is
          -- what lets live clients accept the correction instead of treating it
          -- as a stale payload.
          live_rev         = l.live_rev + 1,
          bid_count        = (SELECT bid_count FROM agg),
          bidder_count     = (SELECT bidder_count FROM agg),
          bidder_ids       = (SELECT bidder_ids FROM agg),
          updated_at       = ${now}::timestamp
        WHERE l.id = ${lotId}
      `);
    });
    return;
  }

  if (body.type === "update_lot") {
    await db.transaction(async (tx) => {
      const lotRows = await tx.execute<{
        id: number;
        start_bid_price: string | null;
        bid_increment: string | null;
        bid_count: number | null;
        winning_amount: string | null;
        winner_bidder_id: number | null;
        quantity: string | null;
        uom_id: number | null;
        plant_location_id: number | null;
        material_location_id: number | null;
        end_time: string | null;
        extended_end_time: string | null;
        bid_limit: string | null;
        last_bid_extension_count: number;
        auction_type: string | null;
        auction_date: string | null;
        sbp_plus_increment_enabled: boolean | null;
        is_last_bid_extension: boolean | null;
        last_bid_extension_window: number | null;
        last_bid_extension_interval: number | null;
        last_bid_extension_count_max: number | null;
        is_reopened: boolean;
        client_id: number;
      }>(sql`
        SELECT l.id,
               l.start_bid_price,
               l.bid_increment,
               l.bid_limit,
               l.bid_count,
               l.winning_amount,
               l.winner_bidder_id,
               l.quantity,
               l.uom_id,
               l.plant_location_id,
               l.material_location_id,
               l.end_time::text AS end_time,
               l.extended_end_time,
               l.last_bid_extension_count,
               l.is_reopened,
               a.auction_type,
               a.auction_date::text AS auction_date,
               a.is_start_bid_price_plus_increment AS sbp_plus_increment_enabled,
               c.id AS client_id,
               c.is_last_bid_extension,
               c.last_bid_extension_window,
               c.last_bid_extension_interval,
               c.last_bid_extension_count_max
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        INNER JOIN clients c ON c.id = a.client_id
        WHERE l.id = ${lotId}
          AND l.auction_id = ${auctionId}
          AND l.is_active = true
        FOR UPDATE OF l
      `);
      const lot = lotRows.rows[0];
      if (!lot) {
        throw new AuctionValidationError(AuctionsErrorMessages.LOT_NOT_FOUND);
      }

      const currentWinningAmount =
        lot.winning_amount != null ? Number(lot.winning_amount) : null;
      const currentQuantity =
        lot.quantity != null ? Number(lot.quantity) : null;
      const nextWinningAmount =
        body.winningAmount !== undefined
          ? body.winningAmount
          : currentWinningAmount;
      const nextWinnerBidderId =
        body.winnerBidderId !== undefined
          ? body.winnerBidderId
          : lot.winner_bidder_id;
      const previousWinnerBidderId = lot.winner_bidder_id;
      const winnerChanged = nextWinnerBidderId !== previousWinnerBidderId;

      const fieldErrors: Record<string, string[]> = {};

      if (
        body.winningAmount != null &&
        !amountsEqual(body.winningAmount, currentWinningAmount)
      ) {
        const startPrice = Number(lot.start_bid_price ?? 0);
        const hasBids = lot.winning_amount != null;
        const priceErr = manualBidAmountError(
          {
            bidCount: hasBids ? 1 : 0,
            currentBid: hasBids ? Number(lot.winning_amount) : startPrice,
            bidIncrement: Number(lot.bid_increment ?? 0),
            startBidPrice: startPrice,
            sbpPlusIncrement: lot.sbp_plus_increment_enabled === true,
            bidLimit:
              lot.bid_limit != null ? Number(lot.bid_limit) : null,
            auctionType: lot.auction_type,
          },
          body.winningAmount,
        );
        if (priceErr) fieldErrors.winningAmount = [priceErr];
      }

      if (body.winningAmount !== undefined && !fieldErrors.winningAmount) {
        const bidIncrementErr = bidIncrementVsPriceError(
          Number(lot.bid_increment ?? 0),
          Number(lot.start_bid_price ?? 0),
          {
            winningAmount: nextWinningAmount,
            bidCount: lot.bid_count ?? 0,
            auctionType: lot.auction_type,
          },
        );
        if (bidIncrementErr) fieldErrors.winningAmount = [bidIncrementErr];
      }

      if (body.quantity != null && !(body.quantity > 0)) {
        fieldErrors.quantity = [
          AuctionsValidationMessages.QUANTITY_MUST_BE_POSITIVE,
        ];
      }

      const currentUomId = lot.uom_id;
      const currentPlantLocationId = lot.plant_location_id;
      const currentMaterialLocationId = lot.material_location_id;

      let nextUomId = currentUomId;
      if (body.uomCode !== undefined) {
        if (!body.uomCode) {
          fieldErrors.uomCode = [AuctionsValidationMessages.UOM_CODE_REQUIRED];
        } else {
          const resolvedUomId = await pgResolveUomId(body.uomCode, {
            allowInactiveId: currentUomId,
          });
          if (!resolvedUomId) {
            fieldErrors.uomCode = [
              AuctionsValidationMessages.UOM_CODE_UNKNOWN(body.uomCode),
            ];
          } else {
            nextUomId = resolvedUomId;
          }
        }
      }

      let nextPlantLocationId = currentPlantLocationId;
      if (body.plantLocationId !== undefined) {
        if (body.plantLocationId == null) {
          fieldErrors.plantLocationId = [
            AuctionsValidationMessages.PLANT_LOCATION_REQUIRED,
          ];
        } else {
          const [plantRow] = await tx
            .select({ id: plantLocations.id, isActive: plantLocations.isActive })
            .from(plantLocations)
            .where(
              and(
                eq(plantLocations.id, body.plantLocationId),
                eq(plantLocations.clientId, lot.client_id),
              ),
            )
            .limit(1);
          if (
            !plantRow ||
            (!plantRow.isActive && plantRow.id !== currentPlantLocationId)
          ) {
            fieldErrors.plantLocationId = [
              AuctionsValidationMessages.PLANT_LOCATION_INVALID_FOR_CLIENT,
            ];
          } else {
            nextPlantLocationId = body.plantLocationId;
          }
        }
      }

      let nextMaterialLocationId = currentMaterialLocationId;
      if (body.materialLocationId !== undefined) {
        if (body.materialLocationId == null) {
          nextMaterialLocationId = null;
        } else {
          const [materialRow] = await tx
            .select({
              id: materialLocations.id,
              isActive: materialLocations.isActive,
            })
            .from(materialLocations)
            .where(
              and(
                eq(materialLocations.id, body.materialLocationId),
                eq(materialLocations.clientId, lot.client_id),
              ),
            )
            .limit(1);
          if (
            !materialRow ||
            (!materialRow.isActive &&
              materialRow.id !== currentMaterialLocationId)
          ) {
            fieldErrors.materialLocationId = [
              AuctionsValidationMessages.MATERIAL_LOCATION_INVALID_FOR_CLIENT,
            ];
          } else {
            nextMaterialLocationId = body.materialLocationId;
          }
        }
      }

      const masterFieldsChanged =
        nextUomId !== currentUomId ||
        nextPlantLocationId !== currentPlantLocationId ||
        nextMaterialLocationId !== currentMaterialLocationId;

      const firstFieldError = Object.values(fieldErrors)[0]?.[0];
      if (firstFieldError) {
        throw new AuctionValidationError(firstFieldError, fieldErrors);
      }

      const correctionCase = classifyUpdateLotCase({
        currentWinnerBidderId: lot.winner_bidder_id,
        currentWinningAmount,
        currentQuantity,
        nextWinnerBidderId: body.winnerBidderId,
        nextWinningAmount: body.winningAmount,
        nextQuantity: body.quantity,
      });

      if (correctionCase === "noop") {
        if (!masterFieldsChanged) {
          return;
        }
        await tx
          .update(auctionLots)
          .set({
            uomId: nextUomId,
            plantLocationId: nextPlantLocationId,
            materialLocationId: nextMaterialLocationId,
            updatedAt: now,
          })
          .where(eq(auctionLots.id, lotId));
        return;
      }

      if (correctionCase === "qty_only") {
        if (body.quantity !== undefined || masterFieldsChanged) {
          await tx
            .update(auctionLots)
            .set({
              ...(body.quantity !== undefined
                ? { quantity: body.quantity == null ? null : String(body.quantity) }
                : {}),
              ...(masterFieldsChanged
                ? {
                    uomId: nextUomId,
                    plantLocationId: nextPlantLocationId,
                    materialLocationId: nextMaterialLocationId,
                  }
                : {}),
              updatedAt: now,
            })
            .where(eq(auctionLots.id, lotId));
        }
        return;
      }

      if (nextWinnerBidderId == null) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.WINNER_BIDDER_REQUIRED,
          {
            winnerBidderId: [
              AuctionsValidationMessages.WINNER_BIDDER_REQUIRED,
            ],
          },
        );
      }
      // Missing price → required. Zero / invalid amounts that changed are
      // already rejected above via manualBidAmountError (bid-floor rules).
      if (nextWinningAmount == null) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.WINNING_AMOUNT_REQUIRED,
          {
            winningAmount: [
              AuctionsValidationMessages.WINNING_AMOUNT_REQUIRED,
            ],
          },
        );
      }
      // Whether the new winner's EMD is blocked from their wallet or held by
      // the client is the admin's explicit call, same as Attach Bidders — only
      // required when the winner is actually changing.
      if (winnerChanged && body.isEmdWithClient === undefined) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.CORRECTION_EMD_WITH_CLIENT_REQUIRED,
          {
            isEmdWithClient: [
              AuctionsValidationMessages.CORRECTION_EMD_WITH_CLIENT_REQUIRED,
            ],
          },
        );
      }

      const clientRes = await tx.execute<{
        client_id: number;
        bidders: number[] | null;
      }>(sql`
        SELECT a.client_id, c.bidders
        FROM auctions a
        INNER JOIN clients c ON c.id = a.client_id
        WHERE a.auction_id = ${auctionId}
        LIMIT 1
      `);
      const clientRow = clientRes.rows[0];
      if (!clientRow) {
        throw new AuctionValidationError(AuctionsErrorMessages.AUCTION_NOT_FOUND);
      }
      if (!isWinnerInClientBidders(clientRow.bidders, nextWinnerBidderId)) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.WINNER_NOT_CLIENT_MAPPED,
          {
            winnerBidderId: [
              AuctionsValidationMessages.WINNER_NOT_CLIENT_MAPPED,
            ],
          },
        );
      }
      const clientId = clientRow.client_id;

      const userRes = await tx.execute<{ id: number }>(sql`
        SELECT id
        FROM users
        WHERE bidder_id = ${nextWinnerBidderId}
          AND is_active = true
        ORDER BY id ASC
        LIMIT 1
      `);
      const winnerUserId = userRes.rows[0]?.id;
      if (winnerUserId == null) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.WINNER_USER_MISSING,
          {
            winnerBidderId: [AuctionsValidationMessages.WINNER_USER_MISSING],
          },
        );
      }

      const amountOrder =
        lot.auction_type === "reverse" ? sql`ASC` : sql`DESC`;

      // Resolve correction bid timestamp first (chronology anchor).
      let bidCreatedAt: string;
      let winningBid:
        | { id: number; bidder_id: number; amount: string }
        | undefined;

      if (correctionCase === "same_price_new_bidder") {
        const winningBidRes = await tx.execute<{
          id: number;
          bidder_id: number;
          amount: string;
          bid_at: string;
        }>(sql`
          SELECT id, bidder_id, amount,
                 (COALESCE(committed_at, created_at) - interval '1 microsecond') AS bid_at
          FROM auction_bids
          WHERE lot_id = ${lotId}
          ORDER BY amount ${amountOrder}, COALESCE(committed_at, created_at) ASC, id ASC
          LIMIT 1
        `);
        winningBid = winningBidRes.rows[0];
        if (!winningBid || !winningBidRes.rows[0]?.bid_at) {
          throw new AuctionValidationError(
            AuctionsValidationMessages.NO_STANDING_BID_FOR_TRANSFER,
          );
        }
        bidCreatedAt = winningBidRes.rows[0].bid_at;
      } else {
        const lastBidRes = await tx.execute<{
          created_at: string;
          bid_at: string;
        }>(sql`
          SELECT created_at,
                 (created_at + (${CORRECTION_NEW_PRICE_AFTER_LAST_BID_MICROSECONDS}::bigint
                   * interval '1 microsecond')) AS bid_at
          FROM auction_bids
          WHERE lot_id = ${lotId}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `);
        const lastBidAt = lastBidRes.rows[0]?.created_at
          ? new Date(lastBidRes.rows[0].created_at)
          : null;
        const effectiveEnd = effectiveLotEnd(
          {
            lotEndTime: lot.end_time,
            lotExtendedEndTime: lot.extended_end_time,
          },
          lot.auction_date,
        );
        const createdAtResult = resolveCorrectionBidCreatedAt({
          lastBidCreatedAt: lastBidAt,
          effectiveEnd,
          // Reopened lots are never last-bid extended.
          isLastBidExtension: lot.is_reopened ? false : lot.is_last_bid_extension,
          lastBidExtensionWindow: lot.last_bid_extension_window,
          lastBidExtensionInterval: lot.last_bid_extension_interval,
          lastBidExtensionCountMax: lot.last_bid_extension_count_max,
          lastBidExtensionCount: lot.last_bid_extension_count,
        });
        if (!createdAtResult.ok) {
          throw new AuctionValidationError(createdAtResult.message);
        }
        bidCreatedAt =
          createdAtResult.afterLastBidMicroseconds > 0 &&
          lastBidRes.rows[0]?.bid_at
            ? lastBidRes.rows[0].bid_at
            : formatUtcNow(createdAtResult.createdAt);
      }

      // TnC accept before bid (if missing).
      await tx.execute(sql`
        INSERT INTO auction_tnc_acceptances (
          auction_id, bidder_id, accepted_at, accepted_by_user_id
        )
        SELECT ${auctionId}, ${nextWinnerBidderId},
               ${bidCreatedAt}::timestamptz - interval '2 microseconds',
               ${winnerUserId}
        WHERE NOT EXISTS (
          SELECT 1 FROM auction_tnc_acceptances
          WHERE auction_id = ${auctionId}
            AND bidder_id = ${nextWinnerBidderId}
        )
      `);

      // Retro lot map before bid (if missing), honoring the admin's EMD-with-client
      // choice for the new winner; an existing map row is updated to match when
      // the winner actually changed (it may predate this correction).
      const mapped = await tx.execute<{ id: number }>(sql`
        SELECT id
        FROM auction_lot_bidder_maps
        WHERE auction_id = ${auctionId}
          AND lot_id = ${lotId}
          AND bidder_id = ${nextWinnerBidderId}
          AND is_active = true
        LIMIT 1
      `);
      if (mapped.rows.length === 0) {
        const nextMapId = await pgNextLotBidderMapId();
        await tx.execute(sql`
          INSERT INTO auction_lot_bidder_maps (
            id, auction_id, client_id, bidder_id, lot_id,
            is_emd_with_client, is_active, created_at, created_by
          ) VALUES (
            ${nextMapId}, ${auctionId}, ${clientId}, ${nextWinnerBidderId}, ${lotId},
            ${body.isEmdWithClient ?? true}, true,
            ${bidCreatedAt}::timestamptz - interval '1 microsecond',
            ${removedByUserId}
          )
        `);
      } else if (winnerChanged) {
        await tx.execute(sql`
          UPDATE auction_lot_bidder_maps
          SET is_emd_with_client = ${body.isEmdWithClient},
              updated_at = ${now}::timestamptz,
              updated_by = ${removedByUserId}
          WHERE id = ${mapped.rows[0]!.id}
        `);
      }

      if (correctionCase === "same_price_new_bidder" && winningBid) {
        await tx.execute(sql`
          UPDATE auction_bid_logs
          SET is_removed = true,
              removed_at = ${now}::timestamptz,
              removed_by = ${removedByUserId},
              reject_reason = ${AuctionsValidationMessages.OFFLINE_NEGOTIATED}
          WHERE id = (
            SELECT id FROM auction_bid_logs
            WHERE lot_id = ${lotId}
              AND bidder_id = ${winningBid.bidder_id}
              AND amount = ${winningBid.amount}::numeric
              AND is_accepted = true
              AND is_removed = false
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
        `);
        await tx.execute(sql`
          DELETE FROM auction_bids WHERE id = ${winningBid.id}
        `);
      }

      await tx.execute(sql`
        INSERT INTO auction_bid_logs (
          auction_id, lot_id, bidder_id, user_id, amount,
          is_proxy, proxy_amount, ip, is_accepted, reject_reason, created_at
        ) VALUES (
          ${auctionId}, ${lotId}, ${nextWinnerBidderId}, ${winnerUserId},
          ${nextWinningAmount.toFixed(2)}::numeric,
          false, null, null, true, null, ${bidCreatedAt}::timestamptz
        )
      `);
      await tx.execute(sql`
        INSERT INTO auction_bids (
          auction_id, lot_id, bidder_id, user_id, amount,
          is_proxy, proxy_amount, ip, created_at
        ) VALUES (
          ${auctionId}, ${lotId}, ${nextWinnerBidderId}, ${winnerUserId},
          ${nextWinningAmount.toFixed(2)}::numeric,
          false, null, null, ${bidCreatedAt}::timestamptz
        )
      `);

      await tx.execute(sql`
        WITH top AS (
          SELECT amount, bidder_id, user_id
          FROM auction_bids
          WHERE lot_id = ${lotId}
          ORDER BY amount ${amountOrder}, COALESCE(committed_at, created_at) ASC, id ASC
          LIMIT 1
        ), agg AS (
          SELECT count(*)::int AS bid_count,
                 count(DISTINCT bidder_id)::int AS bidder_count,
                 COALESCE(array_agg(DISTINCT bidder_id), '{}'::int[]) AS bidder_ids
          FROM auction_bids
          WHERE lot_id = ${lotId}
        )
        UPDATE auction_lots l SET
          winning_amount   = (SELECT amount FROM top),
          winner_bidder_id = (SELECT bidder_id FROM top),
          winner_user_id   = (SELECT user_id FROM top),
          live_rev         = l.live_rev + 1,
          bid_count        = (SELECT bid_count FROM agg),
          bidder_count     = (SELECT bidder_count FROM agg),
          bidder_ids       = (SELECT bidder_ids FROM agg),
          updated_at       = ${now}::timestamp
        WHERE l.id = ${lotId}
      `);

      if (body.quantity !== undefined || masterFieldsChanged) {
        await tx
          .update(auctionLots)
          .set({
            ...(body.quantity !== undefined
              ? { quantity: body.quantity == null ? null : String(body.quantity) }
              : {}),
            ...(masterFieldsChanged
              ? {
                  uomId: nextUomId,
                  plantLocationId: nextPlantLocationId,
                  materialLocationId: nextMaterialLocationId,
                }
              : {}),
            updatedAt: now,
          })
          .where(eq(auctionLots.id, lotId));
      }

      // Reconcile EMD for both sides of a winner change: the old winner can
      // only lose held EMD (never fails); the new winner may need a fresh
      // wallet block and can fail on insufficient balance, rolling back the
      // whole correction. Old winner first so the new winner's balance check
      // reflects their wallet as it stands now, unaffected by auction timing.
      if (winnerChanged) {
        if (previousWinnerBidderId != null) {
          await reconcileWinningHoldForCorrection(tx, {
            auctionId,
            bidderId: previousWinnerBidderId,
            userId: removedByUserId,
          });
        }
        await reconcileWinningHoldForCorrection(tx, {
          auctionId,
          bidderId: nextWinnerBidderId,
          userId: removedByUserId,
        });
      }
    });
  }
}

/**
 * Build a bulk-reopen body for a single lot from its current fields, so the
 * single-lot `reopen_lot` correction goes through `pgReopenLots` unchanged.
 */
export async function pgSingleLotReopenBody(
  auctionId: number,
  lotId: number,
  lotEndTime: string,
): Promise<ReopenLotsCorrectionBody> {
  const [lot] = await db
    .select({
      lotNumber: auctionLots.lotNumber,
      bidIncrement: auctionLots.bidIncrement,
      quantity: auctionLots.quantity,
      uomCode: uoms.code,
    })
    .from(auctionLots)
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.id, lotId),
        eq(auctionLots.isActive, true),
      ),
    )
    .limit(1);
  if (!lot) {
    throw new AuctionValidationError(AuctionsErrorMessages.LOT_NOT_FOUND);
  }
  return {
    lots: [
      {
        lotId,
        lotEndTime,
        lotNumber: lot.lotNumber?.trim() || String(lotId),
        bidIncrement: Number(lot.bidIncrement ?? 0),
        quantity: Number(lot.quantity ?? 0),
        uomCode: lot.uomCode?.trim() ?? "",
      },
    ],
  };
}

/**
 * Bulk reopen closed lots with per-lot field updates.
 *
 * A reopened lot is flagged `is_reopened` and from then on runs on its own end
 * time: it is outside the lot-stagger chain (it neither cascades onto, nor is
 * moved by, other lots), it gets no no-bid or last-bid extensions, and
 * reopening never touches any other lot's end time. Auction-level stagger and
 * no-bid settings are left as they are.
 *
 * Settlement: moves `auction_date` to today (IST), republishes the auction,
 * freezes unreopened lots' effective ends as absolute timestamps.
 *
 * Live (execution): auction stays published/live; auction_date and status are
 * unchanged.
 */
/** Force lot staggering on/off for this one live auction, overriding the client default. */
export async function pgApplyStaggerCorrection(
  auctionId: number,
  body: StaggerCorrectionBody,
  userId: number,
) {
  await db
    .update(auctions)
    .set({
      isStaggered: body.isStaggered,
      updatedAt: formatUtcNow(),
      updatedBy: userId,
    })
    .where(eq(auctions.id, auctionId));
}

export type ReopenLotsContext = "settlement" | "live";

export async function pgReopenLots(
  auctionId: number,
  body: ReopenLotsCorrectionBody,
  context: ReopenLotsContext,
  userId: number,
) {
  const nowDate = new Date();
  const now = formatUtcNow(nowDate);
  const todayAuctionDate = auctionDateIsoForInstant(nowDate);
  const lotIds = body.lots.map((l) => l.lotId);

  await db.transaction(async (tx) => {
    // Serialise with the auto-close sweep, then re-check status under the row
    // lock: otherwise the sweep can close a live auction while a reopen of its
    // last lots is committing.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CLOSE_LOCK_KEY})`);
    const [auction] = await tx
      .select({
        auctionDate: auctions.auctionDate,
        auctionType: auctions.auctionType,
        status: auctions.status,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .limit(1)
      .for("update");
    if (!auction) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.REOPEN_LOTS_REQUIRED,
      );
    }
    const expectedStatus = context === "settlement" ? "closed" : "published";
    if (auction.status !== expectedStatus) {
      throw new AuctionValidationError(
        context === "settlement"
          ? AuctionsValidationMessages.REOPEN_REQUIRES_CLOSED
          : AuctionsValidationMessages.REOPEN_REQUIRES_LIVE,
      );
    }
    if (
      context === "settlement" &&
      !isAuctionDateToday(auction.auctionDate, nowDate)
    ) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.REOPEN_ONLY_SAME_DAY_AS_AUCTION_DATE,
      );
    }
    const previousAuctionDate = auction.auctionDate;
    const scheduleDate =
      context === "settlement" ? todayAuctionDate : previousAuctionDate;
    if (!scheduleDate) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.REOPEN_LOTS_REQUIRED,
      );
    }

    // Settlement reopen republishes the auction but must not walk back
    // approved lots — those are rejected per-lot below.
    const existing = await tx
      .select({
        id: auctionLots.id,
        lotNumber: auctionLots.lotNumber,
        bidCount: auctionLots.bidCount,
        startBidPrice: auctionLots.startBidPrice,
        startTime: auctionLots.startTime,
        bidLimit: auctionLots.bidLimit,
        uomId: auctionLots.uomId,
        displayOrder: auctionLots.displayOrder,
        isApproved: auctionLots.isApproved,
        isClosed: lotIsClosedExpr,
      })
      .from(auctionLots)
      .innerJoin(auctions, eq(auctions.id, auctionLots.auctionId))
      .where(
        and(
          eq(auctionLots.auctionId, auctionId),
          eq(auctionLots.isActive, true),
          inArray(auctionLots.id, lotIds),
        ),
      );

    if (existing.length !== lotIds.length) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.REOPEN_LOTS_REQUIRED,
      );
    }

    const existingById = new Map(existing.map((r) => [r.id, r]));

    // Uniqueness: new numbers must not collide with each other or with
    // other lots in the auction (active + withdrawn; excluding lots being updated).
    const otherLots = await tx
      .select({
        id: auctionLots.id,
        lotNumber: auctionLots.lotNumber,
        isActive: auctionLots.isActive,
      })
      .from(auctionLots)
      .where(eq(auctionLots.auctionId, auctionId));

    const taken = new Set<string>();
    for (const row of otherLots) {
      if (lotIds.includes(row.id)) continue;
      if (!row.lotNumber) continue;
      taken.add(normalizeLotNumberKey(row.lotNumber));
    }

    const seenInBatch = new Set<string>();
    for (const item of body.lots) {
      const key = normalizeLotNumberKey(item.lotNumber);
      if (seenInBatch.has(key) || taken.has(key)) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS,
          { lotNumber: [AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS] },
        );
      }
      seenInBatch.add(key);

      const current = existingById.get(item.lotId)!;
      if (current.isApproved === true) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.REOPEN_NOT_ALLOWED_WHEN_LOT_APPROVED,
        );
      }
      if (!current.isClosed) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.REOPEN_LOT_MUST_BE_CLOSED,
          {
            lotEndTime: [
              AuctionsValidationMessages.REOPEN_LOT_MUST_BE_CLOSED,
            ],
          },
        );
      }
      if (
        item.startBidPrice !== undefined &&
        item.startBidPrice !== null &&
        current.bidCount > 0
      ) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.START_BID_NOT_EDITABLE_WITH_BIDS,
          {
            startBidPrice: [
              AuctionsValidationMessages.START_BID_NOT_EDITABLE_WITH_BIDS,
            ],
          },
        );
      }

      if (
        item.startBidPrice !== undefined &&
        item.startBidPrice !== null &&
        current.bidCount === 0
      ) {
        const bidLimitErr = bidLimitVsStartPriceError(
          auction.auctionType,
          Number(current.bidLimit ?? 0),
          item.startBidPrice,
        );
        if (bidLimitErr) {
          throw new AuctionValidationError(bidLimitErr, {
            startBidPrice: [bidLimitErr],
          });
        }
      }

      const startBidPriceForIncrement =
        current.bidCount === 0 &&
        item.startBidPrice !== undefined &&
        item.startBidPrice !== null
          ? item.startBidPrice
          : Number(current.startBidPrice ?? 0);
      const bidIncrementErr = bidIncrementVsPriceError(
        item.bidIncrement,
        startBidPriceForIncrement,
        { auctionType: auction.auctionType },
      );
      if (bidIncrementErr) {
        throw new AuctionValidationError(bidIncrementErr, {
          bidIncrement: [bidIncrementErr],
        });
      }

      // End time must be in the future on the schedule calendar day.
      if (!isLotEndTimeAfterNow(item.lotEndTime, scheduleDate, nowDate)) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.LOT_END_TIME_MUST_BE_FUTURE,
          {
            lotEndTime: [
              AuctionsValidationMessages.LOT_END_TIME_MUST_BE_FUTURE,
            ],
          },
        );
      }
      if (current.startTime) {
        const endAt = parseLotDateTime(item.lotEndTime, scheduleDate);
        const startAt = parseLotDateTime(current.startTime, scheduleDate);
        if (
          endAt &&
          startAt &&
          endAt.getTime() <= startAt.getTime()
        ) {
          throw new AuctionValidationError(
            AuctionsValidationMessages.LOT_END_TIME_BEFORE_START,
            {
              lotEndTime: [
                AuctionsValidationMessages.LOT_END_TIME_BEFORE_START,
              ],
            },
          );
        }
      }
    }

    // Settlement: freeze unreopened lots at their prior absolute effective end
    // so bumping auction_date to today cannot make them look live again.
    if (
      context === "settlement" &&
      otherLots.some((r) => r.isActive && !lotIds.includes(r.id))
    ) {
      await tx.execute(sql`
        UPDATE auction_lots AS l
        SET
          extended_end_time = COALESCE(
            l.extended_end_time,
            (${previousAuctionDate}::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'
          ),
          live_rev = l.live_rev + 1,
          updated_at = ${now}::timestamptz
        WHERE l.auction_id = ${auctionId}
          AND l.is_active = true
          AND l.id NOT IN (${sql.join(
            lotIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      `);
    }

    for (const item of body.lots) {
      const current = existingById.get(item.lotId)!;
      const uomId = await pgResolveUomId(item.uomCode, {
        allowInactiveId: current.uomId,
      });
      if (!uomId) {
        throw new AuctionValidationError(
          AuctionsValidationMessages.UOM_UNKNOWN,
          { uomCode: [AuctionsValidationMessages.UOM_UNKNOWN] },
        );
      }
      // Keep winning_* / winner_* — they are the live current-leader snapshot
      // (updated on every bid). Clearing them made settlement show empty
      // Winning Price/Bidder after a no-new-bid re-close, and reset the next
      // bid floor to start price despite existing ledger rows.
      const set: {
        status: number;
        endTime: string;
        lotNumber: string;
        bidIncrement: string;
        quantity: string;
        uomId: number;
        startBidPrice?: string;
        extendedEndTime: null;
        lastBidExtensionCount: number;
        noBidExtensionCount: number;
        isNoBidExtension: boolean;
        noBidExtensionStoppedAt: null;
        noBidExtensionStoppedBy: null;
        isReopened: true;
        reopenedAt: string;
        reopenedBy: number;
        liveRev: SQL;
        updatedAt: string;
        updatedBy: number;
      } = {
        status: 1,
        endTime: item.lotEndTime,
        lotNumber: item.lotNumber.trim(),
        bidIncrement: String(item.bidIncrement),
        quantity: String(item.quantity),
        uomId,
        // Clear past extensions so the new end_time (on today's auction_date)
        // is the effective end; otherwise auto-close re-closes within seconds.
        extendedEndTime: null,
        lastBidExtensionCount: 0,
        noBidExtensionCount: 0,
        // Counters reset for a clean audit; extensions stay off via is_reopened.
        isNoBidExtension: true,
        noBidExtensionStoppedAt: null,
        noBidExtensionStoppedBy: null,
        // Outside lot staggering and extensions from here on.
        isReopened: true,
        reopenedAt: now,
        reopenedBy: userId,
        liveRev: sql`live_rev + 1`,
        updatedAt: now,
        updatedBy: userId,
      };

      if (
        item.startBidPrice !== undefined &&
        item.startBidPrice !== null &&
        current.bidCount === 0
      ) {
        set.startBidPrice = String(item.startBidPrice);
      }

      await tx
        .update(auctionLots)
        .set(set)
        .where(
          and(
            eq(auctionLots.auctionId, auctionId),
            eq(auctionLots.id, item.lotId),
            eq(auctionLots.isActive, true),
          ),
        );
    }

    // Live: the auction stays as is. Settlement: republish on today's date —
    // Live Monitor / listLive / Today's Auctions all gate on auction_date =
    // today IST, and closed auctions are often from a prior day.
    if (context === "settlement") {
      await tx
        .update(auctions)
        .set({
          status: "published",
          closedAt: null,
          auctionDate: todayAuctionDate,
          updatedAt: now,
        })
        .where(eq(auctions.id, auctionId));
    }
  });
}

/**
 * Whether the lot's effective end (extended or scheduled) is in the past —
 * and it is not still a no-bid-extension candidate the next tick would keep
 * open (see NO_BID_EXTENSION_PENDING: same predicate the live snapshot uses,
 * so this never disagrees with what bidders see).
 */
export async function pgIsLotClosed(
  auctionId: number,
  lotId: number,
): Promise<boolean> {
  const rows = await db.execute<{ is_closed: boolean }>(sql`
    SELECT (
      (
        EXTRACT(EPOCH FROM (
          COALESCE(
            l.extended_end_time,
            (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'
          ) - now()
        )) <= 0
      )
      AND NOT (${NO_BID_EXTENSION_PENDING})
    ) AS is_closed
    FROM auction_lots l
    INNER JOIN auctions a ON a.auction_id = l.auction_id
    WHERE l.auction_id = ${auctionId}
      AND l.id = ${lotId}
      AND l.is_active = true
    LIMIT 1
  `);
  const row = rows.rows[0];
  return row?.is_closed ?? true;
}

export async function pgUploadAuctionDocument(opts: {
  auctionId: number;
  clientId: number;
  documentTypeId: number;
  buffer: Buffer;
  originalFileName: string;
  userId: number;
  at?: Date;
}) {
  const typeRows = await db
    .select({
      id: auctionDocumentTypes.id,
      fileNamePrefix: auctionDocumentTypes.fileNamePrefix,
    })
    .from(auctionDocumentTypes)
    .where(
      and(
        eq(auctionDocumentTypes.id, opts.documentTypeId),
        eq(auctionDocumentTypes.isActive, true),
      ),
    )
    .limit(1);
  const docType = typeRows[0];
  if (!docType) {
    throw new Error(AuctionsValidationMessages.DOCUMENT_TYPE_NOT_FOUND_OR_INACTIVE);
  }

  const kind = assertAuctionDocumentFile(opts.originalFileName, opts.buffer);
  const storageName = `document${extensionForAuctionDocumentKind(kind)}`;

  const resolved = resolveAuctionDocumentStorage({
    documentTypeId: docType.id,
    fileNamePrefix: docType.fileNamePrefix,
    auctionId: opts.auctionId,
    clientId: opts.clientId,
    originalFileName: storageName,
  });

  await uploadAuctionDocumentBytesToR2({
    s3Key: resolved.s3Key,
    buffer: opts.buffer,
    filename: resolved.filename,
  });

  const existing = await db
    .select({
      id: auctionDocuments.id,
      s3Key: auctionDocuments.s3Key,
    })
    .from(auctionDocuments)
    .where(
      and(
        eq(auctionDocuments.auctionId, opts.auctionId),
        eq(auctionDocuments.documentTypeId, opts.documentTypeId),
      ),
    )
    .limit(1);

  const now = formatUtcNow(opts.at ?? new Date());

  let documentId: number;
  if (existing[0]) {
    documentId = existing[0].id;
    const oldKey = existing[0].s3Key;
    await db
      .update(auctionDocuments)
      .set({
        fileName: resolved.filename,
        s3Key: resolved.s3Key,
        isActive: true,
        updatedAt: now,
        updatedBy: opts.userId,
      })
      .where(eq(auctionDocuments.id, documentId));

    if (oldKey !== resolved.s3Key) {
      try {
        await deleteObject(oldKey);
      } catch {
        // best-effort cleanup
      }
    }
  } else {
    const maxId = await db
      .select({ id: sql<number>`COALESCE(MAX(${auctionDocuments.id}), 0)` })
      .from(auctionDocuments);
    documentId = Number(maxId[0]?.id ?? 0) + 1;

    await db.insert(auctionDocuments).values({
      id: documentId,
      auctionId: opts.auctionId,
      documentTypeId: opts.documentTypeId,
      fileName: resolved.filename,
      s3Key: resolved.s3Key,
      isActive: true,
      createdAt: now,
      createdBy: opts.userId,
    });
  }

  return { id: documentId, documentTypeId: opts.documentTypeId };
}

/**
 * Copy the client's latest Terms & Conditions into this auction's documents.
 * Returns null when the client has no TnC (caller should leave auction without TnC).
 */
export async function pgCopyClientTncToAuction(opts: {
  clientId: number;
  auctionId: number;
  userId: number;
}): Promise<{ id: number; documentTypeId: number } | null> {
  const ref = await getLatestClientDocumentStorageRef(
    opts.clientId,
    CLIENT_DOCUMENT_TYPE_TNC,
  );
  if (!ref) return null;

  const buffer = await getObjectBuffer(ref.s3Key);
  const kind = sniffAuctionDocumentKind(buffer);
  const originalFileName =
    ref.fileName?.trim() ||
    `document${kind ? extensionForAuctionDocumentKind(kind) : ".pdf"}`;

  return pgUploadAuctionDocument({
    auctionId: opts.auctionId,
    clientId: opts.clientId,
    documentTypeId: AUCTION_DOCUMENT_TYPE_TNC,
    buffer,
    originalFileName,
    userId: opts.userId,
  });
}

export async function pgActiveDocumentDownloadUrl(
  auctionId: number,
  documentTypeId: number,
) {
  const rows = await db
    .select({ s3Key: auctionDocuments.s3Key })
    .from(auctionDocuments)
    .where(
      and(
        eq(auctionDocuments.auctionId, auctionId),
        eq(auctionDocuments.documentTypeId, documentTypeId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row?.s3Key) return null;
  return getSignedDownloadUrl(row.s3Key);
}

export async function pgActiveCatalogueDownloadUrl(auctionId: number) {
  return pgActiveDocumentDownloadUrl(
    auctionId,
    AUCTION_DOCUMENT_TYPE_CATALOGUE,
  );
}

export async function pgActiveTncDownloadUrl(auctionId: number) {
  return pgActiveDocumentDownloadUrl(auctionId, AUCTION_DOCUMENT_TYPE_TNC);
}

/** Signed catalogue + T&C URLs for a batch of auctions (at most one of each type). */
export async function pgActiveCatalogueAndTncUrls(
  auctionIds: number[],
): Promise<Map<number, { catalogueUrl: string | null; tncUrl: string | null }>> {
  const result = new Map<
    number,
    { catalogueUrl: string | null; tncUrl: string | null }
  >();
  for (const id of auctionIds) {
    result.set(id, { catalogueUrl: null, tncUrl: null });
  }
  if (auctionIds.length === 0) return result;

  const rows = await db
    .select({
      auctionId: auctionDocuments.auctionId,
      documentTypeId: auctionDocuments.documentTypeId,
      s3Key: auctionDocuments.s3Key,
    })
    .from(auctionDocuments)
    .where(
      and(
        inArray(auctionDocuments.auctionId, auctionIds),
        inArray(auctionDocuments.documentTypeId, [
          AUCTION_DOCUMENT_TYPE_CATALOGUE,
          AUCTION_DOCUMENT_TYPE_TNC,
        ]),
        eq(auctionDocuments.isActive, true),
      ),
    );

  const signed = await Promise.all(
    rows.map(async (r) => ({
      auctionId: r.auctionId,
      documentTypeId: r.documentTypeId,
      url: r.s3Key ? await getSignedDownloadUrl(r.s3Key) : null,
    })),
  );

  for (const r of signed) {
    const entry = result.get(r.auctionId);
    if (!entry) continue;
    if (r.documentTypeId === AUCTION_DOCUMENT_TYPE_CATALOGUE) {
      entry.catalogueUrl = r.url;
    } else if (r.documentTypeId === AUCTION_DOCUMENT_TYPE_TNC) {
      entry.tncUrl = r.url;
    }
  }
  return result;
}

export async function pgAllLotsApproved(auctionId: number): Promise<boolean> {
  const rows = await db
    .select({
      total: count(),
      approved: sql<number>`COUNT(*) FILTER (WHERE ${auctionLots.isApproved} = true)`,
    })
    .from(auctionLots)
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.isActive, true)),
    );
  const total = Number(rows[0]?.total ?? 0);
  const approved = Number(rows[0]?.approved ?? 0);
  return total > 0 && total === approved;
}

export async function pgGetAuctionClientId(
  auctionId: number,
): Promise<number | null> {
  const rows = await db
    .select({ clientId: auctions.clientId })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);
  return rows[0]?.clientId ?? null;
}

export async function pgGetAuctionType(
  auctionId: number,
): Promise<string | null> {
  const rows = await db
    .select({ auctionType: auctions.auctionType })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);
  return rows[0]?.auctionType ?? null;
}

/**
 * Type + auction date + publishedAt for lot write Zod (schedule rules need
 * the calendar day and, for the lot-start-vs-publishedAt check, the
 * auction's Published At instant).
 */
export async function pgGetAuctionLotWriteContext(
  auctionId: number,
): Promise<{
  auctionType: string | null;
  auctionDate: string | null;
  publishedAt: string | null;
} | null> {
  const rows = await db
    .select({
      auctionType: auctions.auctionType,
      auctionDate: auctions.auctionDate,
      publishedAt: auctions.publishedAt,
    })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    auctionType: row.auctionType,
    auctionDate: row.auctionDate,
    publishedAt: row.publishedAt,
  };
}

export async function pgGetAuctionStatus(
  auctionId: number,
): Promise<string | null> {
  const rows = await db
    .select({ status: auctions.status })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);
  return rows[0]?.status ?? null;
}

/** Auction-level no-bid extension master flag, used to seed new lots. */
export async function pgGetAuctionIsNoBidExtension(
  auctionId: number,
): Promise<boolean> {
  const rows = await db
    .select({ isNoBidExtension: auctions.isNoBidExtension })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);
  return rows[0]?.isNoBidExtension ?? true;
}

function normalizeLotNumberKey(lotNumber: string): string {
  return lotNumber.trim().toLowerCase();
}

async function pgNextLotId(): Promise<number> {
  const maxId = await db
    .select({ id: sql<number>`COALESCE(MAX(${auctionLots.id}), 0)` })
    .from(auctionLots);
  return Number(maxId[0]?.id ?? 0) + 1;
}

async function pgNextLotItemId(): Promise<number> {
  const maxId = await db
    .select({ id: sql<number>`COALESCE(MAX(${auctionLotItems.id}), 0)` })
    .from(auctionLotItems);
  return Number(maxId[0]?.id ?? 0) + 1;
}

async function pgNextLotBidderMapId(): Promise<number> {
  const maxId = await db
    .select({ id: sql<number>`COALESCE(MAX(${auctionLotBidderMaps.id}), 0)` })
    .from(auctionLotBidderMaps);
  return Number(maxId[0]?.id ?? 0) + 1;
}

export async function pgLoadUomCodeMap(): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: uoms.id, code: uoms.code })
    .from(uoms)
    .where(eq(uoms.isActive, true));
  return new Map(rows.map((r) => [r.code.trim().toUpperCase(), r.id]));
}

export async function pgResolveUomId(
  uomCode: string,
  opts?: { allowInactiveId?: number | null },
): Promise<number | null> {
  const code = uomCode.trim();
  const rows = await db
    .select({ id: uoms.id, isActive: uoms.isActive })
    .from(uoms)
    .where(sql`lower(${uoms.code}) = ${code.toLowerCase()}`)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (
    row.isActive ||
    (opts?.allowInactiveId != null && row.id === opts.allowInactiveId)
  ) {
    return row.id;
  }
  return null;
}

export async function pgLoadPlantLocationNameMap(
  clientId: number,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: plantLocations.id, name: plantLocations.name })
    .from(plantLocations)
    .where(
      and(
        eq(plantLocations.clientId, clientId),
        eq(plantLocations.isActive, true),
      ),
    );
  return new Map(
    rows
      .filter((r) => r.name != null && r.name.trim() !== "")
      .map((r) => [r.name!.trim().toLowerCase(), r.id]),
  );
}

export async function pgLoadMaterialLocationNameMap(
  clientId: number,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: materialLocations.id, name: materialLocations.name })
    .from(materialLocations)
    .where(
      and(
        eq(materialLocations.clientId, clientId),
        eq(materialLocations.isActive, true),
      ),
    );
  return new Map(
    rows
      .filter((r) => r.name != null && r.name.trim() !== "")
      .map((r) => [r.name!.trim().toLowerCase(), r.id]),
  );
}

export async function pgLoadBenchmarkComboLabelMap(): Promise<
  Map<string, number>
> {
  const rows = await db
    .select({
      id: benchmarkMaterialLocations.id,
      material: benchmarkMaterials.name,
      location: benchmarkLocations.name,
    })
    .from(benchmarkMaterialLocations)
    .innerJoin(benchmarkMaterials, eq(benchmarkMaterials.id, benchmarkMaterialLocations.materialId))
    .innerJoin(benchmarkLocations, eq(benchmarkLocations.id, benchmarkMaterialLocations.locationId))
    .where(eq(benchmarkMaterialLocations.isActive, true));
  return new Map(
    rows.map((r) => [
      `${r.material.trim().toLowerCase()}@@${r.location.trim().toLowerCase()}`,
      r.id,
    ]),
  );
}

export async function pgLoadActiveBenchmarkOptions(): Promise<
  { id: number; label: string }[]
> {
  const rows = await db
    .select({
      id: benchmarkMaterialLocations.id,
      material: benchmarkMaterials.name,
      location: benchmarkLocations.name,
    })
    .from(benchmarkMaterialLocations)
    .innerJoin(benchmarkMaterials, eq(benchmarkMaterials.id, benchmarkMaterialLocations.materialId))
    .innerJoin(benchmarkLocations, eq(benchmarkLocations.id, benchmarkMaterialLocations.locationId))
    .where(eq(benchmarkMaterialLocations.isActive, true))
    .orderBy(asc(benchmarkMaterials.name), asc(benchmarkLocations.name));
  return rows.map((b) => ({
    id: b.id,
    label: `${b.material}@@${b.location}`,
  }));
}

export async function pgLoadClientItemIdSet(
  clientId: number,
): Promise<Set<number>> {
  const rows = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.clientId, clientId), eq(items.isActive, true)));
  return new Set(rows.map((r) => r.id));
}

export async function pgListLotEditorOptions(clientId: number) {
  const [plants, materials, uomRows, benchmarks, itemRows] = await Promise.all([
    db
      .select({ id: plantLocations.id, name: plantLocations.name })
      .from(plantLocations)
      .where(
        and(
          eq(plantLocations.clientId, clientId),
          eq(plantLocations.isActive, true),
        ),
      )
      .orderBy(asc(plantLocations.name)),
    db
      .select({ id: materialLocations.id, name: materialLocations.name })
      .from(materialLocations)
      .where(
        and(
          eq(materialLocations.clientId, clientId),
          eq(materialLocations.isActive, true),
        ),
      )
      .orderBy(asc(materialLocations.name)),
    db
      .select({ id: uoms.id, code: uoms.code })
      .from(uoms)
      .where(eq(uoms.isActive, true))
      .orderBy(asc(uoms.code)),
    db
      .select({
        id: benchmarkMaterialLocations.id,
        material: benchmarkMaterials.name,
        location: benchmarkLocations.name,
      })
      .from(benchmarkMaterialLocations)
      .innerJoin(benchmarkMaterials, eq(benchmarkMaterials.id, benchmarkMaterialLocations.materialId))
      .innerJoin(benchmarkLocations, eq(benchmarkLocations.id, benchmarkMaterialLocations.locationId))
      .where(eq(benchmarkMaterialLocations.isActive, true))
      .orderBy(asc(benchmarkMaterials.name), asc(benchmarkLocations.name)),
    db
      .select({ id: items.id, name: items.name })
      .from(items)
      .where(and(eq(items.clientId, clientId), eq(items.isActive, true)))
      .orderBy(asc(items.name)),
  ]);

  return {
    plantLocations: plants,
    materialLocations: materials,
    uoms: uomRows,
    benchmarks: benchmarks.map((b) => ({
      id: b.id,
      label: `${b.material}@@${b.location}`,
      material: b.material,
      location: b.location,
    })),
    items: itemRows,
  };
}

type LotWriteMasterExisting = {
  plantLocationId: number | null;
  materialLocationId: number | null;
  itemId: number | null;
  benchmarkMaterialLocationId: number | null;
  uomId: number | null;
};

async function pgMaterialIdsForItemIds(
  itemIds: number[],
): Promise<number[]> {
  const unique = [...new Set(itemIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (unique.length === 0) return [];
  const rows = await db
    .select({ materialId: items.materialId })
    .from(items)
    .where(inArray(items.id, unique));
  return [
    ...new Set(
      rows
        .map((r) => r.materialId)
        .filter((id): id is number => id != null && id > 0),
    ),
  ];
}

async function pgMaterialIdsForLotIds(lotIds: number[]): Promise<number[]> {
  const unique = [...new Set(lotIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (unique.length === 0) return [];
  const rows = await db
    .select({ materialId: items.materialId })
    .from(auctionLotItems)
    .innerJoin(items, eq(items.id, auctionLotItems.itemId))
    .where(
      and(
        inArray(auctionLotItems.lotId, unique),
        eq(auctionLotItems.isActive, true),
      ),
    );
  return [
    ...new Set(
      rows
        .map((r) => r.materialId)
        .filter((id): id is number => id != null && id > 0),
    ),
  ];
}

export async function pgUnionClientMaterialsFromItemIds(
  executor: SqlExecutor,
  clientId: number,
  itemIds: number[],
  userId: number,
): Promise<void> {
  const materialIds = await pgMaterialIdsForItemIds(itemIds);
  if (materialIds.length === 0) return;
  await unionClientMaterials(executor, clientId, materialIds, userId);
}

export async function pgRecordBidderClientParticipation(
  executor: SqlExecutor,
  clientId: number,
  bidderIds: number[],
  lotIds: number[],
  userId: number,
): Promise<void> {
  const uniqueBidders = [...new Set(bidderIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (uniqueBidders.length === 0) return;

  await unionClientBidders(executor, clientId, uniqueBidders, userId);

  const materialIds = await pgMaterialIdsForLotIds(lotIds);
  if (materialIds.length === 0) return;

  await unionBidderMaterialsMany(executor, uniqueBidders, materialIds, userId);
}

async function assertLotWriteMasters(
  clientId: number,
  body: AuctionLotWriteBody,
  existing?: LotWriteMasterExisting | null,
): Promise<void> {
  const [plant, material, item] = await Promise.all([
    db
      .select({ id: plantLocations.id, isActive: plantLocations.isActive })
      .from(plantLocations)
      .where(
        and(
          eq(plantLocations.id, body.plantLocationId),
          eq(plantLocations.clientId, clientId),
        ),
      )
      .limit(1),
    body.materialLocationId != null
      ? db
          .select({
            id: materialLocations.id,
            isActive: materialLocations.isActive,
          })
          .from(materialLocations)
          .where(
            and(
              eq(materialLocations.id, body.materialLocationId),
              eq(materialLocations.clientId, clientId),
            ),
          )
          .limit(1)
      : Promise.resolve([] as Array<{ id: number; isActive: boolean }>),
    db
      .select({ id: items.id, isActive: items.isActive })
      .from(items)
      .where(and(eq(items.id, body.itemId), eq(items.clientId, clientId)))
      .limit(1),
  ]);
  const plantRow = plant[0];
  const materialRow = material[0];
  const itemRow = item[0];
  if (
    !plantRow ||
    (!plantRow.isActive && plantRow.id !== existing?.plantLocationId)
  ) {
    throw new Error(AuctionsValidationMessages.PLANT_LOCATION_INVALID_FOR_CLIENT);
  }
  if (
    body.materialLocationId != null &&
    (!materialRow ||
      (!materialRow.isActive &&
        materialRow.id !== existing?.materialLocationId))
  ) {
    throw new Error(
      AuctionsValidationMessages.MATERIAL_LOCATION_INVALID_FOR_CLIENT,
    );
  }
  if (!itemRow || (!itemRow.isActive && itemRow.id !== existing?.itemId)) {
    throw new Error(AuctionsValidationMessages.ITEM_INVALID_FOR_CLIENT);
  }

  if (body.benchmarkMaterialLocationId != null) {
    const bench = await db
      .select({
        id: benchmarkMaterialLocations.id,
        isActive: benchmarkMaterialLocations.isActive,
      })
      .from(benchmarkMaterialLocations)
      .where(
        eq(benchmarkMaterialLocations.id, body.benchmarkMaterialLocationId),
      )
      .limit(1);
    const benchRow = bench[0];
    if (
      !benchRow ||
      (!benchRow.isActive &&
        benchRow.id !== existing?.benchmarkMaterialLocationId)
    ) {
      throw new Error(
        AuctionsValidationMessages.BENCHMARK_MATERIAL_LOCATION_INVALID,
      );
    }
  }
}

/**
 * Lot numbers for uniqueness checks (active + withdrawn). Soft-withdrawn lots
 * still occupy their lot number so create/import cannot reuse it.
 */
export async function pgLoadExistingLotNumberKeys(
  auctionId: number,
  opts?: { excludeLotId?: number },
): Promise<Set<string>> {
  const rows = await db
    .select({
      id: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
    })
    .from(auctionLots)
    .where(eq(auctionLots.auctionId, auctionId));
  return new Set(
    rows
      .filter((r) =>
        opts?.excludeLotId == null ? true : r.id !== opts.excludeLotId,
      )
      .map((r) => (r.lotNumber ? normalizeLotNumberKey(r.lotNumber) : ""))
      .filter(Boolean),
  );
}

export type ExistingLotByDisplayOrder = {
  id: number;
  displayOrderKey: string;
  isActive: boolean;
  lotNumber: string | null;
};

/**
 * All lots (active + withdrawn) keyed by normalized display order for import upsert.
 * Withdrawn slots occupy the key so import can skip them without inserting duplicates.
 */
export async function pgLoadExistingLotsByDisplayOrder(
  auctionId: number,
): Promise<Map<string, ExistingLotByDisplayOrder>> {
  const rows = await db
    .select({
      id: auctionLots.id,
      displayOrder: auctionLots.displayOrder,
      isActive: auctionLots.isActive,
      lotNumber: auctionLots.lotNumber,
    })
    .from(auctionLots)
    .where(eq(auctionLots.auctionId, auctionId));

  const map = new Map<string, ExistingLotByDisplayOrder>();
  for (const r of rows) {
    if (r.displayOrder == null) continue;
    const key = normalizeDisplayOrderKey(r.displayOrder);
    if (!key) continue;
    map.set(key, {
      id: r.id,
      displayOrderKey: key,
      isActive: r.isActive,
      lotNumber: r.lotNumber,
    });
  }
  return map;
}

/** @deprecated Prefer pgLoadExistingLotsByDisplayOrder */
export type ExistingLotByNumber = {
  id: number;
  displayOrderKey: string;
};

/** @deprecated Prefer pgLoadExistingLotsByDisplayOrder */
export async function pgLoadExistingLotsByNumber(
  auctionId: number,
): Promise<Map<string, ExistingLotByNumber>> {
  const rows = await db
    .select({
      id: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
      displayOrder: auctionLots.displayOrder,
    })
    .from(auctionLots)
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.isActive, true)),
    );

  const map = new Map<string, ExistingLotByNumber>();
  for (const r of rows) {
    if (!r.lotNumber) continue;
    const key = normalizeLotNumberKey(r.lotNumber);
    if (!key) continue;
    map.set(key, {
      id: r.id,
      displayOrderKey:
        r.displayOrder != null ? normalizeDisplayOrderKey(r.displayOrder) : "",
    });
  }
  return map;
}

export async function pgLoadWithdrawnDisplayOrderKeys(
  auctionId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({
      displayOrder: auctionLots.displayOrder,
    })
    .from(auctionLots)
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.isActive, false),
      ),
    );
  return new Set(
    rows
      .map((r) =>
        r.displayOrder != null ? normalizeDisplayOrderKey(r.displayOrder) : "",
      )
      .filter(Boolean),
  );
}

export async function pgLoadExistingDisplayOrderKeys(
  auctionId: number,
  opts?: { excludeLotId?: number },
): Promise<Set<string>> {
  const rows = await db
    .select({
      id: auctionLots.id,
      displayOrder: auctionLots.displayOrder,
    })
    .from(auctionLots)
    .where(eq(auctionLots.auctionId, auctionId));
  return new Set(
    rows
      .filter((r) =>
        opts?.excludeLotId == null ? true : r.id !== opts.excludeLotId,
      )
      .map((r) =>
        r.displayOrder != null ? normalizeDisplayOrderKey(r.displayOrder) : "",
      )
      .filter(Boolean),
  );
}

export async function pgWithdrawLots(
  auctionId: number,
  lotIds: number[],
  userId: number,
): Promise<number> {
  if (lotIds.length === 0) return 0;
  const now = formatUtcNow();
  return db.transaction(async (tx) => {
    const result = await tx
      .update(auctionLots)
      .set({
        isActive: false,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(
        and(
          eq(auctionLots.auctionId, auctionId),
          inArray(auctionLots.id, lotIds),
          eq(auctionLots.isActive, true),
        ),
      )
      .returning({ id: auctionLots.id });
    if (result.length > 0) {
      await emdSettlementService.enqueue(tx, {
        auctionId,
        kind: "lot_withdrawn",
        lotId: result.length === 1 ? result[0]!.id : null,
        createdBy: userId,
      });
    }
    return result.length;
  });
}

export async function pgWithdrawLot(
  auctionId: number,
  lotId: number,
  userId: number,
): Promise<"ok" | "not_found" | "already_withdrawn"> {
  const rows = await db
    .select({ id: auctionLots.id, isActive: auctionLots.isActive })
    .from(auctionLots)
    .where(
      and(eq(auctionLots.auctionId, auctionId), eq(auctionLots.id, lotId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return "not_found";
  if (!row.isActive) return "already_withdrawn";
  await pgWithdrawLots(auctionId, [lotId], userId);
  return "ok";
}

/**
 * Hard-delete every lot for an auction (active + withdrawn) and lot-scoped children.
 * EMD ranges / confirmation docs are auction-scoped and left intact.
 */
export async function pgDeleteAllLots(auctionId: number): Promise<number> {
  const lotRows = await db
    .select({ id: auctionLots.id })
    .from(auctionLots)
    .where(eq(auctionLots.auctionId, auctionId));
  const lotIds = lotRows.map((r) => r.id);
  if (lotIds.length === 0) return 0;

  await db.transaction(async (tx) => {
    await tx
      .delete(liftingEngagementLogs)
      .where(inArray(liftingEngagementLogs.lotId, lotIds));
    await tx
      .delete(liftingClientLogs)
      .where(inArray(liftingClientLogs.lotId, lotIds));
    await tx
      .delete(auctionProxyBids)
      .where(inArray(auctionProxyBids.lotId, lotIds));
    await tx
      .delete(auctionBidLogs)
      .where(inArray(auctionBidLogs.lotId, lotIds));
    await tx.delete(auctionBids).where(inArray(auctionBids.lotId, lotIds));
    await tx
      .delete(auctionLotWatchlist)
      .where(inArray(auctionLotWatchlist.lotId, lotIds));
    await tx
      .delete(auctionLotExtensions)
      .where(inArray(auctionLotExtensions.lotId, lotIds));
    await tx
      .delete(auctionLotItems)
      .where(inArray(auctionLotItems.lotId, lotIds));
    await tx
      .delete(auctionLotBidderMaps)
      .where(
        and(
          eq(auctionLotBidderMaps.auctionId, auctionId),
          inArray(auctionLotBidderMaps.lotId, lotIds),
        ),
      );
    await tx.delete(auctionLots).where(eq(auctionLots.auctionId, auctionId));
  });

  return lotIds.length;
}

export type PgLotInsertRow = AuctionLotWriteBody & {
  rowNumber: number;
  uomId: number;
};

export type PgLotUpdateRow = PgLotInsertRow & {
  lotId: number;
};

export type CreateLotBody = AuctionLotWriteBody;

export async function pgCreateLot(
  auctionId: number,
  clientId: number,
  body: CreateLotBody,
  userId: number,
): Promise<number> {
  const lotKey = normalizeLotNumberKey(body.lotNumber);
  const existing = await pgLoadExistingLotNumberKeys(auctionId);
  if (existing.has(lotKey)) {
    throw new Error(AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS);
  }

  const existingDisplayOrders = await pgLoadExistingDisplayOrderKeys(auctionId);
  assertDisplayOrderAvailable(existingDisplayOrders, body.displayOrder);

  await assertLotWriteMasters(clientId, body);

  const uomId = await pgResolveUomId(body.uomCode);
  if (!uomId) {
    throw new Error(AuctionsValidationMessages.UOM_CODE_UNKNOWN(body.uomCode));
  }

  const nextId = await pgNextLotId();
  const nextItemId = await pgNextLotItemId();
  const now = formatUtcNow();
  const isNoBidExtension = await pgGetAuctionIsNoBidExtension(auctionId);

  await db.insert(auctionLots).values({
    id: nextId,
    clientId,
    auctionId,
    isNoBidExtension,
    lotNumber: body.lotNumber.trim(),
    quantity: String(body.quantity),
    startBidPrice: String(body.startBidPrice),
    displayOrder: String(body.displayOrder),
    uomId,
    bidIncrement: String(body.bidIncrement),
    bidLimit: String(body.bidLimit),
    startTime: body.lotStartTime,
    endTime: body.lotEndTime,
    plantLocationId: body.plantLocationId,
    materialLocationId: body.materialLocationId ?? null,
    materialLiftingDays: body.materialLiftingDays ?? null,
    loadingScope: body.loadingScope,
    gstPercentage: String(body.gstPercentage),
    tcsPercentage: String(body.tcsPercentage),
    remark: body.remark.trim(),
    status: 0,
    isApproved: null,
    isActive: true,
    createdAt: now,
    createdBy: userId,
  });

  await db.insert(auctionLotItems).values({
    id: nextItemId,
    clientId,
    auctionId,
    lotId: nextId,
    itemId: body.itemId,
    quantity: String(body.quantity),
    benchmarkMaterialLocationId: body.benchmarkMaterialLocationId ?? null,
    materialName: body.materialName.trim(),
    materialDescription: body.materialDescription ?? null,
      isActive: true,
      createdAt: now,
      createdBy: userId,
    });

  await pgUnionClientMaterialsFromItemIds(db, clientId, [body.itemId], userId);

  return nextId;
}

export async function pgBulkInsertLots(
  auctionId: number,
  clientId: number,
  rows: PgLotInsertRow[],
  userId: number,
): Promise<void> {
  if (rows.length === 0) return;

  let nextId = await pgNextLotId();
  let nextItemId = await pgNextLotItemId();
  const now = formatUtcNow();
  const isNoBidExtension = await pgGetAuctionIsNoBidExtension(auctionId);

  const lotValues = rows.map((row) => {
    const id = nextId++;
    return {
      id,
      clientId,
      auctionId,
      isNoBidExtension,
      lotNumber: row.lotNumber.trim(),
      quantity: String(row.quantity),
      startBidPrice: String(row.startBidPrice),
      displayOrder: String(row.displayOrder),
      uomId: row.uomId,
      bidIncrement: String(row.bidIncrement),
      bidLimit: String(row.bidLimit),
      startTime: row.lotStartTime,
      endTime: row.lotEndTime,
      plantLocationId: row.plantLocationId,
      materialLocationId: row.materialLocationId,
      materialLiftingDays: row.materialLiftingDays ?? null,
      loadingScope: row.loadingScope,
      gstPercentage: String(row.gstPercentage),
      tcsPercentage: String(row.tcsPercentage),
      remark: row.remark.trim(),
      status: 0,
      isApproved: null,
      isActive: true,
      createdAt: now,
      createdBy: userId,
      _item: row,
    };
  });

  await db
    .insert(auctionLots)
    .values(lotValues.map(({ _item: _, ...lot }) => lot));

  await db.insert(auctionLotItems).values(
    lotValues.map((lot) => {
      const itemId = nextItemId++;
      const row = lot._item;
      return {
        id: itemId,
        clientId,
        auctionId,
        lotId: lot.id,
        itemId: row.itemId,
        quantity: String(row.quantity),
        benchmarkMaterialLocationId: row.benchmarkMaterialLocationId ?? null,
        materialName: row.materialName.trim(),
        materialDescription: row.materialDescription ?? null,
        isActive: true,
        createdAt: now,
        createdBy: userId,
      };
    }),
  );

  await pgUnionClientMaterialsFromItemIds(
    db,
    clientId,
    rows.map((r) => r.itemId),
    userId,
  );
}

/** Bulk-update lots for import upsert (masters already resolved). */
export async function pgBulkUpdateLots(
  auctionId: number,
  clientId: number,
  rows: PgLotUpdateRow[],
  userId: number,
): Promise<void> {
  if (rows.length === 0) return;

  const now = formatUtcNow();
  const lotIds = rows.map((r) => r.lotId);

  const existingLotRows = await db
    .select({
      id: auctionLots.id,
      startTime: auctionLots.startTime,
      endTime: auctionLots.endTime,
    })
    .from(auctionLots)
    .where(
      and(eq(auctionLots.auctionId, auctionId), inArray(auctionLots.id, lotIds)),
    );
  const priorTimesByLotId = new Map(
    existingLotRows.map((r) => [r.id, { startTime: r.startTime, endTime: r.endTime }]),
  );

  const existingItemRows = await db
    .select({
      id: auctionLotItems.id,
      lotId: auctionLotItems.lotId,
    })
    .from(auctionLotItems)
    .where(
      and(
        eq(auctionLotItems.auctionId, auctionId),
        inArray(auctionLotItems.lotId, lotIds),
        eq(auctionLotItems.isActive, true),
      ),
    )
    .orderBy(asc(auctionLotItems.id));

  const itemIdByLotId = new Map<number, number>();
  for (const item of existingItemRows) {
    if (!itemIdByLotId.has(item.lotId)) {
      itemIdByLotId.set(item.lotId, item.id);
    }
  }

  const needsNewItems = rows.some((r) => !itemIdByLotId.has(r.lotId));
  let nextItemId = needsNewItems ? await pgNextLotItemId() : 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .update(auctionLots)
        .set({
          lotNumber: row.lotNumber.trim(),
          materialLiftingDays: row.materialLiftingDays ?? null,
          plantLocationId: row.plantLocationId,
          materialLocationId: row.materialLocationId,
          gstPercentage: String(row.gstPercentage),
          tcsPercentage: String(row.tcsPercentage),
          startBidPrice: String(row.startBidPrice),
          bidLimit: String(row.bidLimit),
          bidIncrement: String(row.bidIncrement),
          startTime: row.lotStartTime,
          endTime: row.lotEndTime,
          loadingScope: row.loadingScope,
          displayOrder: String(row.displayOrder),
          remark: row.remark.trim(),
          quantity: String(row.quantity),
          uomId: row.uomId,
          updatedAt: now,
          updatedBy: userId,
        })
        .where(
          and(
            eq(auctionLots.auctionId, auctionId),
            eq(auctionLots.id, row.lotId),
          ),
        );

      // A stale extended_end_time from a prior live extension must not
      // outlive a freshly-imported start/end time (effective_end always
      // prefers extended_end_time when set) — mirrors the reset already done
      // by the reopen flow and the single-lot edit flow in this same file.
      const prior = priorTimesByLotId.get(row.lotId);
      if (
        prior &&
        (prior.startTime !== row.lotStartTime || prior.endTime !== row.lotEndTime)
      ) {
        await clearLotExtensionState(tx, auctionId, [row.lotId], userId);
      }

      const existingItemId = itemIdByLotId.get(row.lotId);
      if (existingItemId != null) {
        await tx
          .update(auctionLotItems)
          .set({
            itemId: row.itemId,
            quantity: String(row.quantity),
            benchmarkMaterialLocationId:
              row.benchmarkMaterialLocationId ?? null,
            materialName: row.materialName.trim(),
            materialDescription: row.materialDescription ?? null,
            updatedAt: now,
            updatedBy: userId,
          })
          .where(eq(auctionLotItems.id, existingItemId));
      } else {
        const itemId = nextItemId++;
        await tx.insert(auctionLotItems).values({
          id: itemId,
          clientId,
          auctionId,
          lotId: row.lotId,
          itemId: row.itemId,
          quantity: String(row.quantity),
          benchmarkMaterialLocationId: row.benchmarkMaterialLocationId ?? null,
          materialName: row.materialName.trim(),
          materialDescription: row.materialDescription ?? null,
          isActive: true,
          createdAt: now,
          createdBy: userId,
        });
      }
    }
  });

  await pgUnionClientMaterialsFromItemIds(
    db,
    clientId,
    rows.map((r) => r.itemId),
    userId,
  );
}

export async function pgAddBidderPoolEntries(
  auctionId: number,
  clientId: number,
  bidderIds: number[],
  userId: number,
): Promise<number> {
  if (bidderIds.length === 0) return 0;

  const uniqueIds = [...new Set(bidderIds)];
  const existingRows = await db
    .select({ bidderId: auctionLotBidderMaps.bidderId })
    .from(auctionLotBidderMaps)
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.isActive, true),
        sql`${auctionLotBidderMaps.lotId} IS NULL`,
      ),
    );
  const existing = new Set(existingRows.map((r) => r.bidderId));

  const validBidders = await db
    .select({ id: bidders.id })
    .from(bidders)
    .where(and(inArray(bidders.id, uniqueIds), eq(bidders.isVerified, true)));
  const validIds = new Set(validBidders.map((r) => r.id));

  let nextId = await pgNextLotBidderMapId();
  const now = formatUtcNow();
  const toInsert = uniqueIds.filter(
    (bidderId) => validIds.has(bidderId) && !existing.has(bidderId),
  );

  if (toInsert.length === 0) return 0;

  await db.insert(auctionLotBidderMaps).values(
    toInsert.map((bidderId) => ({
      id: nextId++,
      auctionId,
      clientId,
      bidderId,
      lotId: null,
      isActive: true,
      createdAt: now,
      createdBy: userId,
    })),
  );

  await unionClientBidders(db, clientId, toInsert, userId);

  return toInsert.length;
}

export async function pgSetLotBidders(
  auctionId: number,
  clientId: number,
  lotId: number,
  bidderIds: number[],
  userId: number,
): Promise<void> {
  const now = formatUtcNow();
  const uniqueIds = [...new Set(bidderIds)];

  const currentRows = await db
    .select({
      id: auctionLotBidderMaps.id,
      bidderId: auctionLotBidderMaps.bidderId,
    })
    .from(auctionLotBidderMaps)
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.lotId, lotId),
        eq(auctionLotBidderMaps.isActive, true),
      ),
    );

  const verifiedIds =
    uniqueIds.length === 0
      ? new Set<number>()
      : new Set(
          (
            await db
              .select({ id: bidders.id })
              .from(bidders)
              .where(
                and(inArray(bidders.id, uniqueIds), eq(bidders.isVerified, true)),
              )
          ).map((r) => r.id),
        );

  const currentByBidder = new Map(
    currentRows.map((r) => [r.bidderId, r.id] as const),
  );
  // Unverified ids are dropped from the replacement set so a draft save cannot
  // keep or add them. Live published attaches do not use this replace path.
  const target = new Set(uniqueIds.filter((id) => verifiedIds.has(id)));

  const toDeactivate = currentRows
    .filter((r) => !target.has(r.bidderId))
    .map((r) => r.id);
  if (toDeactivate.length > 0) {
    await db
      .update(auctionLotBidderMaps)
      .set({ isActive: false, updatedAt: now, updatedBy: userId })
      .where(inArray(auctionLotBidderMaps.id, toDeactivate));
  }

  let nextId = await pgNextLotBidderMapId();
  const toInsert = uniqueIds.filter(
    (bidderId) => verifiedIds.has(bidderId) && !currentByBidder.has(bidderId),
  );

  if (toInsert.length > 0) {
    await db.insert(auctionLotBidderMaps).values(
      toInsert.map((bidderId) => ({
        id: nextId++,
        auctionId,
        clientId,
        bidderId,
        lotId,
        isActive: true,
        createdAt: now,
        createdBy: userId,
      })),
    );

    await pgRecordBidderClientParticipation(
      db,
      clientId,
      toInsert,
      [lotId],
      userId,
    );
  }
}

export async function pgBulkMapBidders(
  auctionId: number,
  clientId: number,
  mappings: Array<{ lotId: number; bidderIds: number[] }>,
  userId: number,
): Promise<void> {
  for (const mapping of mappings) {
    await pgSetLotBidders(
      auctionId,
      clientId,
      mapping.lotId,
      mapping.bidderIds,
      userId,
    );
  }
}

export type PgBidderWallet = {
  bidderId: number;
  companyName: string;
  emdAvailable: number;
  isVerified: boolean;
};

/** Bidder company name + wallet balance available to block EMD against. */
export async function pgBidderEmdWallets(
  bidderIds: number[],
): Promise<PgBidderWallet[]> {
  if (bidderIds.length === 0) return [];
  const rows = await db
    .select({
      id: bidders.id,
      companyName: bidders.companyName,
      emdAvailable: bidders.emdAvailableBalance,
      isVerified: bidders.isVerified,
    })
    .from(bidders)
    .where(inArray(bidders.id, [...new Set(bidderIds)]));

  return rows.map((r) => ({
    bidderId: r.id,
    companyName: r.companyName,
    emdAvailable: Number(r.emdAvailable ?? 0),
    isVerified: r.isVerified,
  }));
}

/**
 * EMD to block when a bidder is attached. `targetBlockAmount` is the Full block
 * for the bidder's whole wallet-blocked lot set on the auction (lots whose EMD
 * is not with the client), computed by the caller from the post-attach lot set.
 * It is ignored when the attach only adds EMD-with-client lots.
 */
export type PgAttachEmd = {
  targetBlockAmount: number;
};

/**
 * Active lot ids already mapped for this bidder among `lotIds`.
 */
export async function pgActiveMappedLotIds(
  auctionId: number,
  bidderId: number,
  lotIds: number[],
): Promise<Set<number>> {
  const uniqueLotIds = [...new Set(lotIds)].filter(
    (id): id is number => id != null,
  );
  if (uniqueLotIds.length === 0) return new Set();

  const rows = await db
    .select({ lotId: auctionLotBidderMaps.lotId })
    .from(auctionLotBidderMaps)
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.bidderId, bidderId),
        eq(auctionLotBidderMaps.isActive, true),
        inArray(auctionLotBidderMaps.lotId, uniqueLotIds),
      ),
    );

  return new Set(
    rows.map((r) => r.lotId).filter((id): id is number => id != null),
  );
}

/**
 * `lotId -> isEmdWithClient` for the bidder's active maps among `lotIds`.
 */
export async function pgActiveMappedLotFlags(
  auctionId: number,
  bidderId: number,
  lotIds: number[],
): Promise<Map<number, boolean>> {
  const uniqueLotIds = [...new Set(lotIds)];
  if (uniqueLotIds.length === 0) return new Map();

  const rows = await db
    .select({
      lotId: auctionLotBidderMaps.lotId,
      isEmdWithClient: auctionLotBidderMaps.isEmdWithClient,
    })
    .from(auctionLotBidderMaps)
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.bidderId, bidderId),
        eq(auctionLotBidderMaps.isActive, true),
        inArray(auctionLotBidderMaps.lotId, uniqueLotIds),
      ),
    );

  const flags = new Map<number, boolean>();
  for (const r of rows) {
    if (r.lotId != null) flags.set(r.lotId, r.isEmdWithClient ?? false);
  }
  return flags;
}

/** The bidder's active maps among `lotIds` whose EMD was released at close and not re-attached since. */
export async function pgReleasedMappedLotIds(
  auctionId: number,
  bidderId: number,
  lotIds: number[],
): Promise<Set<number>> {
  const uniqueLotIds = [...new Set(lotIds)];
  if (uniqueLotIds.length === 0) return new Set();
  const rows = await db
    .select({ lotId: auctionLotBidderMaps.lotId })
    .from(auctionLotBidderMaps)
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.bidderId, bidderId),
        eq(auctionLotBidderMaps.isActive, true),
        eq(auctionLotBidderMaps.emdReleased, true),
        inArray(auctionLotBidderMaps.lotId, uniqueLotIds),
      ),
    );
  return new Set(rows.map((r) => r.lotId).filter((id): id is number => id != null));
}

/**
 * Every lot this bidder is actively mapped to on the auction. Pool rows
 * (`lot_id IS NULL`) are excluded — only per-lot maps carry an EMD requirement.
 */
export async function pgActiveMappedLotsTx(
  executor: Tx | typeof db,
  auctionId: number,
  bidderId: number,
): Promise<Array<{ lotId: number; isEmdWithClient: boolean; emdReleased: boolean }>> {
  const rows = await executor
    .select({
      lotId: auctionLotBidderMaps.lotId,
      isEmdWithClient: auctionLotBidderMaps.isEmdWithClient,
      emdReleased: auctionLotBidderMaps.emdReleased,
    })
    .from(auctionLotBidderMaps)
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.bidderId, bidderId),
        eq(auctionLotBidderMaps.isActive, true),
        isNotNull(auctionLotBidderMaps.lotId),
      ),
    );
  const lots: Array<{ lotId: number; isEmdWithClient: boolean; emdReleased: boolean }> = [];
  for (const r of rows) {
    if (r.lotId != null) {
      lots.push({
        lotId: r.lotId,
        isEmdWithClient: r.isEmdWithClient ?? false,
        emdReleased: r.emdReleased,
      });
    }
  }
  return lots;
}

export async function pgActiveMappedLotIdsTx(
  executor: Tx | typeof db,
  auctionId: number,
  bidderId: number,
): Promise<number[]> {
  return (await pgActiveMappedLotsTx(executor, auctionId, bidderId)).map((l) => l.lotId);
}

/**
 * Lots whose EMD is already held for a range the bidder won on this auction
 * (an auction that was closed and reopened): every lot of that range, since a
 * range is paid for once. Their EMD is already blocked, so a new attach or
 * detach must not charge it again.
 */
export async function pgHeldCoveredLotIds(
  executor: Tx | typeof db,
  auctionId: number,
  bidderId: number,
): Promise<Set<number>> {
  const res = await executor.execute<{ id: number }>(sql`
    SELECT DISTINCT l.id
    FROM emd_range_holds h
    JOIN auction_lots l ON l.auction_id = h.auction_id AND l.is_active
    LEFT JOIN auction_lot_emd_ranges r ON r.id = h.emd_range_id
    WHERE h.auction_id = ${auctionId} AND h.bidder_id = ${bidderId}
      AND h.amount_held - h.amount_released - h.amount_forfeited > 0
      AND (
        (h.emd_range_id IS NULL AND l.id = ANY(h.lot_ids))
        OR (r.id IS NOT NULL
            AND l.display_order >= r.lot_display_order_from
            AND l.display_order <= r.lot_display_order_to)
      )
  `);
  return new Set(res.rows.map((r) => r.id));
}

/**
 * Active lots whose EMD sits on the bidder's live block: held in the wallet
 * (not with the client), not released at close and not already held for a won
 * range.
 */
export async function pgActiveWalletLotIdsTx(
  executor: Tx | typeof db,
  auctionId: number,
  bidderId: number,
): Promise<number[]> {
  const held = await pgHeldCoveredLotIds(executor, auctionId, bidderId);
  return (await pgActiveMappedLotsTx(executor, auctionId, bidderId))
    .filter((l) => !l.isEmdWithClient && !l.emdReleased && !held.has(l.lotId))
    .map((l) => l.lotId);
}

/**
 * Map a single bidder to the given lots (carrying `is_emd_with_client`) and, in
 * the same transaction, move the bidder's EMD block for the auction — one
 * consolidated Full block per (auction, bidder) covering the lots whose EMD is
 * not with the client. Lots that already have an active map keep their row but
 * take the requested `is_emd_with_client`, so the flag can be changed in place
 * and the block follows it.
 */
export type PgAttachBidderToLotsResult = {
  attachedLotIds: number[];
  skippedLotIds: number[];
  /** Existing lots whose EMD-with-client flag was changed. */
  updatedLotIds?: number[];
  /** No new lots, but the block was moved (re-attach of an EMD-released bidder). */
  reblocked?: boolean;
};

export async function pgAttachBidderToLots(
  auctionId: number,
  clientId: number,
  bidderId: number,
  lotIds: number[],
  isEmdWithClient: boolean,
  userId: number,
  emd: PgAttachEmd,
): Promise<PgAttachBidderToLotsResult> {
  if (lotIds.length === 0) {
    return { attachedLotIds: [], skippedLotIds: [] };
  }
  const [verified] = await db
    .select({ id: bidders.id })
    .from(bidders)
    .where(and(eq(bidders.id, bidderId), eq(bidders.isVerified, true)))
    .limit(1);
  if (!verified) {
    return { attachedLotIds: [], skippedLotIds: [...new Set(lotIds)] };
  }
  const now = formatUtcNow();
  const uniqueLotIds = [...new Set(lotIds)];

  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select({
        lotId: auctionLotBidderMaps.lotId,
        isEmdWithClient: auctionLotBidderMaps.isEmdWithClient,
        emdReleased: auctionLotBidderMaps.emdReleased,
      })
      .from(auctionLotBidderMaps)
      .where(
        and(
          eq(auctionLotBidderMaps.auctionId, auctionId),
          eq(auctionLotBidderMaps.bidderId, bidderId),
          eq(auctionLotBidderMaps.isActive, true),
          inArray(auctionLotBidderMaps.lotId, uniqueLotIds),
        ),
      );

    const existingFlagByLot = new Map<number, boolean>();
    const releasedLots: number[] = [];
    for (const r of existingRows) {
      if (r.lotId == null) continue;
      existingFlagByLot.set(r.lotId, r.isEmdWithClient ?? false);
      if (r.emdReleased) releasedLots.push(r.lotId);
    }
    const toInsertLots = uniqueLotIds.filter((l) => !existingFlagByLot.has(l));
    const toUpdateLots = uniqueLotIds.filter(
      (l) => existingFlagByLot.has(l) && existingFlagByLot.get(l) !== isEmdWithClient,
    );
    const skippedLotIds = uniqueLotIds.filter(
      (l) => existingFlagByLot.has(l) && existingFlagByLot.get(l) === isEmdWithClient,
    );

    // Nothing new to map or change is only a no-op when none of the selected
    // lots was released at an earlier close. Re-attaching a released lot after a
    // reopen is already mapped but needs its block posted again.
    const nothingChanged =
      toInsertLots.length === 0 && toUpdateLots.length === 0 && releasedLots.length === 0;
    if (nothingChanged) {
      return { attachedLotIds: [], skippedLotIds };
    }
    const reblockOnly =
      toInsertLots.length === 0 && toUpdateLots.length === 0 && releasedLots.length > 0;

    const walletLotIdsBefore = await pgActiveWalletLotIdsTx(tx, auctionId, bidderId);

    if (toInsertLots.length > 0) {
      let nextId = await pgNextLotBidderMapId();
      await tx.insert(auctionLotBidderMaps).values(
        toInsertLots.map((lotId) => ({
          id: nextId++,
          auctionId,
          clientId,
          bidderId,
          lotId,
          isEmdWithClient,
          isActive: true,
          createdAt: now,
          createdBy: userId,
        })),
      );
    }

    if (releasedLots.length > 0) {
      await tx
        .update(auctionLotBidderMaps)
        .set({ emdReleased: false, updatedAt: now, updatedBy: userId })
        .where(
          and(
            eq(auctionLotBidderMaps.auctionId, auctionId),
            eq(auctionLotBidderMaps.bidderId, bidderId),
            eq(auctionLotBidderMaps.isActive, true),
            inArray(auctionLotBidderMaps.lotId, releasedLots),
          ),
        );
    }

    if (toUpdateLots.length > 0) {
      await tx
        .update(auctionLotBidderMaps)
        .set({ isEmdWithClient, updatedAt: now, updatedBy: userId })
        .where(
          and(
            eq(auctionLotBidderMaps.auctionId, auctionId),
            eq(auctionLotBidderMaps.bidderId, bidderId),
            eq(auctionLotBidderMaps.isActive, true),
            inArray(auctionLotBidderMaps.lotId, toUpdateLots),
          ),
        );
    }

    // Adding only EMD-with-client lots leaves the wallet block untouched. Any
    // wallet lot added, or any flag flip, moves it to the requirement of the
    // wallet lots now mapped; with none left the block is released in full. The
    // ledger writer locks the bidder and rejects a block above Available.
    const touchesWallet =
      !isEmdWithClient || toUpdateLots.length > 0 || releasedLots.length > 0;
    if (touchesWallet) {
      const walletLotIds = await pgActiveWalletLotIdsTx(tx, auctionId, bidderId);
      if (walletLotIds.length === 0 || emd.targetBlockAmount <= 0) {
        await emdBlocksService.releaseFullBlock(tx, {
          auctionId,
          bidderId,
          emdType: "release_bidder_detached",
          lotIds: walletLotIdsBefore,
          userId,
        });
      } else {
        await emdBlocksService.reconcileBlock(tx, {
          auctionId,
          bidderId,
          targetAmount: round2(emd.targetBlockAmount),
          blockStatus: "full",
          lotIds: walletLotIds,
          userId,
        });
      }
    }

    if (reblockOnly) {
      return { attachedLotIds: [], skippedLotIds, reblocked: true };
    }

    // Standing maps: client↔bidder + bidder materials from attached lots.
    if (toInsertLots.length > 0) {
      await pgRecordBidderClientParticipation(
        tx,
        clientId,
        [bidderId],
        toInsertLots,
        userId,
      );
    }

    return { attachedLotIds: toInsertLots, skippedLotIds, updatedLotIds: toUpdateLots };
  });
}

/**
 * Soft-remove active lot–bidder map rows for the selected bidder × lot
 * cross-product. Pairs with no active mapping are skipped.
 */
export async function pgDetachBiddersFromLots(
  auctionId: number,
  bidderIds: number[],
  lotIds: number[],
  userId: number,
  executor: Tx | typeof db = db,
): Promise<{ removed: number }> {
  const uniqueBidderIds = [...new Set(bidderIds)];
  const uniqueLotIds = [...new Set(lotIds)];
  if (uniqueBidderIds.length === 0 || uniqueLotIds.length === 0) {
    return { removed: 0 };
  }

  const now = formatUtcNow();
  const existingRows = await executor
    .select({ id: auctionLotBidderMaps.id })
    .from(auctionLotBidderMaps)
    .where(
      and(
        eq(auctionLotBidderMaps.auctionId, auctionId),
        eq(auctionLotBidderMaps.isActive, true),
        inArray(auctionLotBidderMaps.bidderId, uniqueBidderIds),
        inArray(auctionLotBidderMaps.lotId, uniqueLotIds),
      ),
    );

  const toDeactivateIds = existingRows.map((r) => r.id);
  if (toDeactivateIds.length === 0) {
    return { removed: 0 };
  }

  await executor
    .update(auctionLotBidderMaps)
    .set({ isActive: false, updatedAt: now, updatedBy: userId })
    .where(inArray(auctionLotBidderMaps.id, toDeactivateIds));

  return { removed: toDeactivateIds.length };
}

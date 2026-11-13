import type { AuctionStatus } from "../schema/auctions.js";

export type AuctionSeedFlags = {
  isDeleted: boolean;
  isClosed: boolean;
  isPublished: boolean;
  activeLotCount: number;
  updatedAt: string | null;
};

export type ResolvedSeedStatus = {
  status: AuctionStatus;
  closedAt: string | null;
};

/**
 * Map legacy tbl_Data_Auction flags → consolidated MECE status.
 *
 * Zero active lots never become published/closed (mirrors runtime publish gate):
 *   archived  ← no lots + IsDeleted
 *   draft     ← no lots + !IsDeleted
 *
 * With lots (ordered if + return):
 *   archived  ← IsDeleted
 *   closed    ← IsClosed
 *   published ← IsPublished
 *   draft     ← otherwise
 *
 * IsArchived / IsCanceled / IsApproved and lot schedules are ignored.
 * Schedule buckets (live/upcoming/future) are not statuses — derived at read time.
 */
export function resolveAuctionSeedStatus(
  r: AuctionSeedFlags,
): ResolvedSeedStatus {
  if (r.activeLotCount === 0) {
    if (r.isDeleted) return { status: "archived", closedAt: null };
    return { status: "draft", closedAt: null };
  }

  if (r.isDeleted) return { status: "archived", closedAt: null };
  if (r.isClosed) return { status: "closed", closedAt: r.updatedAt };
  if (r.isPublished) return { status: "published", closedAt: null };
  return { status: "draft", closedAt: null };
}

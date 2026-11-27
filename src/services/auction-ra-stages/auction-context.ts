import { AuctionRaStagesErrorMessages } from "@auctionit/messages/auction-ra-stages";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctions } from "../../db/schema/auctions.js";
import { earliestLotStartSql } from "../../lib/auctions/list-order.js";
import { AuctionNotFoundError } from "../auctions-errors.js";
import { AuctionRaStageValidationError } from "./errors.js";

export type AuctionRaStageAuctionContext = {
  auctionId: number;
  clientId: number;
  auctionDate: string;
  /** auctionDate combined with the earliest active lot's start time — the
   * instant the auction itself actually begins. Every enabled RA stage must
   * finish before this, regardless of auctionType. */
  auctionStartsAt: string;
  auctionStatus: string;
};

/** RA Stages only apply to reverse auctions — validated on every write path. */
export async function requireReverseAuction(
  auctionId: number,
): Promise<AuctionRaStageAuctionContext> {
  const [row] = await db
    .select({
      id: auctions.id,
      clientId: auctions.clientId,
      auctionType: auctions.auctionType,
      auctionDate: auctions.auctionDate,
      status: auctions.status,
      auctionStartsAt: sql<string>`${earliestLotStartSql()}`,
    })
    .from(auctions)
    .where(eq(auctions.id, auctionId))
    .limit(1);

  if (!row) {
    throw new AuctionNotFoundError();
  }
  if (row.auctionType !== "reverse") {
    throw new AuctionRaStageValidationError(
      AuctionRaStagesErrorMessages.AUCTION_NOT_REVERSE_TYPE,
    );
  }

  return {
    auctionId: row.id,
    clientId: row.clientId,
    auctionDate: row.auctionDate,
    auctionStartsAt: row.auctionStartsAt,
    auctionStatus: row.status,
  };
}

/** Wraps `requireReverseAuction` and additionally enforces that the auction is
 * in `published` status. Used on all write paths — stage setup, config toggle,
 * invite, withdraw, and shortlist/reject decisions. */
export async function requireEditableReverseAuction(
  auctionId: number,
): Promise<AuctionRaStageAuctionContext> {
  const ctx = await requireReverseAuction(auctionId);
  if (ctx.auctionStatus !== "published") {
    throw new AuctionRaStageValidationError(
      AuctionRaStagesErrorMessages.AUCTION_NOT_EDITABLE,
    );
  }
  return ctx;
}

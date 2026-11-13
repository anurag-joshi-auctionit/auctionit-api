import { z } from "../zod.js";

// Shapes built inline in src/routes/bidder-auctions.ts (mapListRow, mapAuctionHeader,
// assignedLots, participatedLots, the /pending-tnc mapper).

const localDateTime = z.string().openapi({
  description: "IST wall-clock date-time without offset.",
  example: "2026-10-21T00:00:00",
});

export const BidderAuctionListItem = z
  .object({
    id: z.number().int(),
    auctionNumber: z.string().nullable(),
    auctionType: z.string().nullable(),
    clientId: z.number().int().nullable(),
    clientName: z.string().nullable(),
    auctionDate: localDateTime,
    lotStartTime: z
      .string()
      .nullable()
      .openapi({ description: "Earliest active lot start time-of-day (HH:mm:ss).", example: "11:00:00" }),
    status: z.string().openapi({ description: "`published` (today/future) or `closed`." }),
    lotCount: z.number().int().openapi({
      description: "today/future: lots the bidder is mapped to; closed: distinct lots the bidder bid on.",
    }),
    bucket: z.enum(["today", "future", "closed"]),
    liveState: z
      .enum(["live", "upcoming"])
      .nullable()
      .openapi({ description: "Only for `today`: `upcoming` before the first lot starts, then `live`." }),
    hasCatalogue: z.boolean(),
    hasTnc: z.boolean(),
    tncAccepted: z.boolean(),
  })
  .openapi("BidderAuctionListItem");

export const BidderAuctionList = z.object({ items: z.array(BidderAuctionListItem) }).openapi("BidderAuctionList");

export const BidderAuctionPendingTnc = z
  .array(
    z.object({
      id: z.number().int(),
      auctionNumber: z.string().nullable(),
      clientName: z.string().nullable(),
      auctionDate: localDateTime,
    }),
  )
  .openapi("BidderAuctionPendingTnc");

export const BidderAuctionTncAccepted = z
  .object({ ok: z.literal(true), accepted: z.literal(true) })
  .openapi("BidderAuctionTncAccepted");

const BidderAuctionHeader = z
  .object({
    id: z.number().int(),
    auctionNumber: z.string().nullable(),
    auctionType: z.string().nullable(),
    clientId: z.number().int().nullable(),
    clientName: z.string().nullable(),
    auctionDate: localDateTime.nullable(),
    status: z.string(),
    liveState: z
      .enum(["live", "upcoming"])
      .nullable()
      .openapi({ description: "`upcoming` before the first lot start, else `live` (also `live` for closed auctions)." }),
  })
  .openapi("BidderAuctionHeader");

export const BidderAuctionAssignedLot = z
  .object({
    id: z.number().int(),
    lotNumber: z.string().nullable(),
    startTime: z.string().nullable().openapi({ description: "Time of day, HH:mm:ss (IST)." }),
    endTime: z.string().nullable().openapi({ description: "Scheduled time of day, HH:mm:ss (IST); excludes extensions." }),
    quantity: z.number().nullable(),
    uom: z.string().nullable(),
    bidIncrement: z.number().nullable(),
    plantLocation: z.string().nullable(),
    materialLocation: z.string().nullable(),
  })
  .openapi("BidderAuctionAssignedLot", { description: "Schedule preview; carries no bid amounts or start price." });

export const BidderAuctionParticipatedLot = z
  .object({
    id: z.number().int(),
    lotNumber: z.string().nullable(),
    quantity: z.number().nullable(),
    uom: z.string().nullable(),
    plantLocation: z.string().nullable(),
    materialLocation: z.string().nullable(),
    myLastBid: z.number().nullable().openapi({ description: "The bidder's chronologically last bid on the lot." }),
    winningAmount: z.number().nullable(),
    winnerBidderId: z.number().int().nullable(),
  })
  .openapi("BidderAuctionParticipatedLot");

export const BidderAuctionDetail = z
  .discriminatedUnion("view", [
    z.object({
      view: z.literal("assigned"),
      auction: BidderAuctionHeader,
      lots: z.array(BidderAuctionAssignedLot),
    }),
    z.object({
      view: z.literal("participated"),
      auction: BidderAuctionHeader,
      lots: z.array(BidderAuctionParticipatedLot),
    }),
  ])
  .openapi("BidderAuctionDetail", {
    description:
      "Published auctions → `assigned` (schedule of the bidder's mapped lots). Closed auctions → `participated` " +
      "(only lots the bidder bid on, with their last bid and the winning amount).",
  });

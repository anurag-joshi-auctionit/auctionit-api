import { z } from "../zod.js";

// Mirrors the client-portal return shapes in services/auctions.service.ts
// (scheduledAuctions, portalClosedAuctions, portalAuctionDetail, portalApprovalLots,
// portalClosedLots, portalUpcomingLots, auctionParticipants) and lot-confirmation.service.ts.

const localDateTime = (description: string) =>
  z.string().nullable().openapi({ description, example: "2026-10-21T11:00:00" });

const scheduledBase = {
  clientId: z.number().int().nullable(),
  clientName: z.string().nullable(),
  auctionId: z.number().int(),
  auctionNumber: z.string().nullable(),
  auctionType: z.string().nullable(),
  startTime: localDateTime("Earliest lot start (IST wall-clock, no offset); falls back to the auction date."),
  auctionDate: z.string().nullable().openapi({ description: "YYYY-MM-DD." }),
  catalogueUrl: z.string().nullable().openapi({ description: "Signed download URL of the active catalogue." }),
  tncUrl: z.string().nullable().openapi({ description: "Signed download URL of the active T&C document." }),
};

export const ClientAuctionScheduled = z
  .object({
    ...scheduledBase,
    status: z.enum(["live", "upcoming"]).openapi({
      description: "`upcoming` before the earliest lot start, `live` after it (auctions whose lots all ended are omitted).",
    }),
  })
  .openapi("ClientAuctionScheduled");

export const ClientAuctionScheduledList = z.array(ClientAuctionScheduled).openapi("ClientAuctionScheduledList");

export const ClientAuctionClosed = z
  .object({
    ...scheduledBase,
    startTime: localDateTime("Auction date-time (IST wall-clock, no offset)."),
    status: z.literal("closed"),
    lotCount: z.number().int(),
    approvedLotCount: z.number().int(),
  })
  .openapi("ClientAuctionClosed");

export const ClientAuctionClosedList = z.array(ClientAuctionClosed).openapi("ClientAuctionClosedList");

export const ClientAuctionUpcomingLot = z
  .object({
    id: z.number().int(),
    lotNumber: z.string().nullable(),
    startTime: localDateTime("Lot start (IST wall-clock)."),
    endTime: localDateTime("Lot end including extensions (IST wall-clock)."),
    quantity: z.number().nullable(),
    uom: z.string().nullable(),
    startBidPrice: z.number().nullable(),
    bidIncrement: z.number().nullable(),
  })
  .openapi("ClientAuctionUpcomingLot");

export const ClientAuctionClosedLot = ClientAuctionUpcomingLot.extend({
  winningPrice: z.number().nullable(),
  winnerBidderId: z.number().int().nullable(),
  winnerBidderName: z.string().nullable(),
  bidCount: z.number().int(),
  bidderCount: z.number().int(),
}).openapi("ClientAuctionClosedLot");

const header = {
  auctionId: z.number().int(),
  auctionNumber: z.string().nullable(),
  auctionType: z.string().nullable(),
  clientName: z.string().nullable(),
};

export const ClientAuctionUpcomingLots = z
  .object({
    ...header,
    startTime: localDateTime("Earliest lot start (IST wall-clock)."),
    lots: z.array(ClientAuctionUpcomingLot),
  })
  .openapi("ClientAuctionUpcomingLots");

export const ClientAuctionClosedLots = z
  .object({
    ...header,
    auctionDate: z.string().nullable(),
    lots: z.array(ClientAuctionClosedLot),
  })
  .openapi("ClientAuctionClosedLots");

export const ClientAuctionLotsResponse = z
  .union([ClientAuctionUpcomingLots, ClientAuctionClosedLots])
  .openapi("ClientAuctionLotsResponse", {
    description: "`ClientAuctionClosedLots` with `bucket=closed`, otherwise `ClientAuctionUpcomingLots`.",
  });

const ClientAuctionMeta = z
  .object({
    auctionId: z.number().int(),
    auctionNumber: z.string().nullable(),
    auctionType: z.string().nullable(),
    clientId: z.number().int().nullable(),
    clientName: z.string().nullable(),
    auctionDate: z.string().nullable(),
    status: z.string().openapi({ description: "`published` or `closed`." }),
  })
  .openapi("ClientAuctionMeta");

export const ClientAuctionDetail = z
  .discriminatedUnion("view", [
    z.object({ view: z.literal("closed"), auction: ClientAuctionMeta, lots: z.array(ClientAuctionClosedLot) }),
    z.object({ view: z.literal("live"), auction: ClientAuctionMeta }),
    z.object({ view: z.literal("upcoming"), auction: ClientAuctionMeta, lots: z.array(ClientAuctionUpcomingLot) }),
  ])
  .openapi("ClientAuctionDetail", {
    description:
      "`view` picks the body: `closed` (lots with winners), `live` (meta only — use the live routes), or `upcoming` (lot schedule).",
  });

export const ClientAuctionApprovalLot = z
  .object({
    lotId: z.number().int(),
    lotNumber: z.string().nullable(),
    quantity: z.number().nullable(),
    uom: z.string().nullable(),
    startBidPrice: z.number().nullable(),
    winningPrice: z.number().nullable(),
    winnerBidderId: z.number().int().nullable(),
    winnerBidderName: z.string().nullable(),
    bidCount: z.number().int(),
    bidderCount: z.number().int(),
    gstPercentage: z.number().nullable(),
    tcsPercentage: z.number().nullable(),
    isApproved: z.boolean().nullable().openapi({ description: "`true` approved, `false` rejected, `null` pending." }),
    remark: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewedByName: z.string().nullable(),
    plantLocationName: z.string().nullable(),
    itemName: z.string().nullable(),
  })
  .openapi("ClientAuctionApprovalLot");

export const ClientAuctionApprovalLots = z
  .object({ ...header, auctionDate: z.string().nullable(), lots: z.array(ClientAuctionApprovalLot) })
  .openapi("ClientAuctionApprovalLots");

export const ClientAuctionNotifyResult = z
  .object({
    ok: z.literal(true),
    emailedBidderCount: z.number().int(),
    lotCount: z.number().int(),
  })
  .openapi("ClientAuctionNotifyResult");

export const ClientAuctionParticipant = z
  .object({
    bidderId: z.number().int(),
    companyName: z.string().nullable(),
    userId: z.number().int().nullable(),
    loginId: z.string().nullable(),
    isLoggedIn: z.boolean(),
    tncAccepted: z.boolean(),
  })
  .openapi("ClientAuctionParticipant");

export const ClientAuctionParticipantList = z.array(ClientAuctionParticipant).openapi("ClientAuctionParticipantList");

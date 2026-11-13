import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors LiftingLotRow / LiftingEngagementDto / LiftingListMeta / LiftingFilterOptions in
// services/lifting.service.ts.

/** `{ error: "lot_not_found" | "not_found" | "log_not_found", message }` 404 body used by the lifting routers. */
export const LiftingNotFoundBody = z
  .object({
    error: z.string().openapi({ example: "lot_not_found" }),
    message: z.string(),
  })
  .openapi("LiftingNotFoundBody");

export const LiftingLot = z
  .object({
    id: z.string().openapi({ description: "Lot id as a string (the auction lot id)." }),
    auctionDate: z.string(),
    lotConfirmation: z.string().nullable(),
    liftingDue: z.string().nullable(),
    auctionName: z.string(),
    clientName: z.string(),
    plantName: z.string(),
    lotNumber: z.string(),
    bidderName: z.string(),
    contactPhone: z.string(),
    auctionType: z.string().nullable(),
    uom: z.string(),
    approvedQty: z.number(),
    liftedQtyBidder: z.number().openapi({ description: "Quantity lifted as reported by the bidder." }),
    liftedQtyClient: z.number().openapi({ description: "Quantity lifted as reported by the client." }),
    balanceQty: z.number(),
    dispositionStatus: z.number().int().nullable(),
    dispositionStatusLabel: z.string().nullable(),
    nextFollowup: z.string().nullable(),
    lastModified: z.string(),
    searchKey: z.string(),
  })
  .openapi("LiftingLot");

export const LiftingLotList = paginated(LiftingLot).openapi("LiftingLotList");

export const LiftingStats = z
  .object({
    totalCount: z.number().int(),
    liftingOngoing: z.number().int(),
    partialLiftingDone: z.number().int(),
    liftingCompleted: z.number().int(),
    todayFollowup: z.number().int().openapi({ description: "Lots whose next follow-up falls on `todayDate`." }),
  })
  .openapi("LiftingStats");

const LiftingIdName = z.object({ id: z.number().int(), name: z.string() });

export const LiftingFilterOptions = z
  .object({ clients: z.array(LiftingIdName), bidders: z.array(LiftingIdName) })
  .openapi("LiftingFilterOptions");

export const LiftingLotResponse = z.object({ lot: LiftingLot }).openapi("LiftingLotResponse");

export const LiftingEngagement = z
  .object({
    id: z.string(),
    dateTime: z.string(),
    dispositionStatus: z.number().int(),
    dispositionStatusLabel: z.string(),
    notes: z.string(),
    liftedQtyBidder: z.number().nullable(),
    loggedByUserId: z.string().nullable(),
    loggedByUserName: z.string().nullable(),
  })
  .openapi("LiftingEngagement");

export const LiftingEngagementList = z
  .object({ engagements: z.array(LiftingEngagement) })
  .openapi("LiftingEngagementList");

export const LiftingEngagementCreated = z
  .object({ lot: LiftingLot, engagement: LiftingEngagement })
  .openapi("LiftingEngagementCreated");

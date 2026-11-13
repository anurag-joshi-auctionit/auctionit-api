import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors LiftingClient* types in services/lifting-clients.service.ts.

export const LiftingClientLot = z
  .object({
    id: z.string().openapi({ description: "Lot id as a string." }),
    clientId: z.number().int(),
    auctionId: z.number().int(),
    auctionDate: z.string(),
    auctionName: z.string(),
    clientName: z.string(),
    plantName: z.string(),
    lotNumber: z.string(),
    bidderName: z.string(),
    contactPhone: z.string(),
    auctionType: z.string().nullable(),
    approvedQty: z.number(),
    totalLiftedQty: z.number(),
    balanceQty: z.number(),
    lastLiftedDate: z.string().nullable(),
    dispositionStatus: z.number().int(),
    dispositionStatusLabel: z.string(),
    remarks: z.string(),
  })
  .openapi("LiftingClientLot");

export const LiftingClientLotList = paginated(LiftingClientLot).openapi("LiftingClientLotList");

export const LiftingClientLotResponse = z.object({ lot: LiftingClientLot }).openapi("LiftingClientLotResponse");

export const LiftingClientFilterClients = z
  .object({
    clients: z.array(z.object({ clientId: z.number().int(), companyName: z.string() })),
  })
  .openapi("LiftingClientFilterClients");

export const LiftingClientFilterAuctions = z
  .object({
    auctions: z.array(
      z.object({
        label: z.string(),
        auctionNumber: z.string(),
        clientId: z.number().int(),
        auctionId: z.number().int(),
      }),
    ),
  })
  .openapi("LiftingClientFilterAuctions");

export const LiftingClientLog = z
  .object({
    id: z.string(),
    liftedQty: z.number(),
    liftedDate: z.string(),
    dispositionStatus: z.number().int(),
    dispositionStatusLabel: z.string(),
    remarks: z.string(),
    loggedAt: z.string(),
    createdByUserId: z.string(),
    createdByUserName: z.string().nullable(),
  })
  .openapi("LiftingClientLog");

export const LiftingClientLogList = paginated(LiftingClientLog).openapi("LiftingClientLogList");

export const LiftingClientLogUpdated = z
  .object({ lot: LiftingClientLot, log: LiftingClientLog })
  .openapi("LiftingClientLogUpdated");

// Import SSE payloads — ImportProgress / ImportResult / ImportSseError in packages/xlsx-import/src/types.ts.

export const LiftingImportProgress = z
  .object({
    phase: z.enum(["parse", "import"]),
    processed: z.number().int(),
    total: z.number().int(),
    percent: z.number(),
    label: z.string(),
  })
  .openapi("LiftingImportProgress");

export const LiftingImportResult = z
  .object({
    imported: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    issues: z.array(
      z.object({
        rowNumber: z.number().int(),
        kind: z.enum(["error", "skipped", "uploaded"]),
        reason: z.string(),
        fieldErrors: z.record(z.array(z.string())).optional(),
      }),
    ),
    issuesTruncated: z.boolean().optional(),
  })
  .openapi("LiftingImportResult");

export const LiftingImportError = z
  .object({ message: z.string(), code: z.string().optional() })
  .openapi("LiftingImportError");

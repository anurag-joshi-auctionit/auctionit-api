import { auctionListFilterSchema, auctionStatusSchema } from "../../lib/auctions/schemas.js";
import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors the return types of services/auctions.service.ts, services/auctions-pg.service.ts,
// services/auction-additional-fields.service.ts, services/catalogue-notification.service.ts,
// services/auction-lot-import-staging.service.ts and lib/auction-lot-import-types.ts.

const int = () => z.number().int();
const ScheduleBucket = z
  .enum(["future", "upcoming", "live"])
  .nullable()
  .openapi({ description: "Only set for `published` auctions; derived from the lot schedule (IST)." });

const TimeOfDay = z.string().openapi({ description: "Time of day `HH:mm:ss`.", example: "11:00:00" });

/* ------------------------------------------------------------------ */
/* Auction list / stats / options                                      */
/* ------------------------------------------------------------------ */

export const AuctionStatusCounts = z
  .object(
    Object.fromEntries(auctionListFilterSchema.options.map((k) => [k, int()])) as Record<
      (typeof auctionListFilterSchema.options)[number],
      ReturnType<typeof int>
    >,
  )
  .openapi("AuctionStatusCounts", {
    description: "Auction count per list filter (status tabs and schedule buckets).",
  });

export const AuctionStats = z.object({ counts: AuctionStatusCounts }).openapi("AuctionStats");

/** AuctionListItem in services/auctions.service.ts. */
export const AuctionListItem = z
  .object({
    auctionId: int(),
    auctionNumber: z.string().nullable(),
    clientId: int(),
    clientName: z.string().nullable(),
    auctionDate: z.string(),
    publishedAt: z.string().nullable(),
    lotCount: int(),
    approvedLotCount: int(),
    bidderCount: int(),
    lotStartTime: TimeOfDay.nullable().openapi({ description: "Earliest active lot start time." }),
    totalQty: z.number().nullable(),
    soldQty: z.number().nullable(),
    uom: z.string().nullable(),
    status: auctionStatusSchema,
    scheduleBucket: ScheduleBucket,
    needsApproval: z.boolean().openapi({ description: "Has lots and not all of them are approved." }),
    hasCatalogue: z.boolean(),
    hasTnc: z.boolean(),
    catalogueUrl: z.string().nullable().openapi({ description: "Signed download URL." }),
    tncUrl: z.string().nullable().openapi({ description: "Signed download URL." }),
  })
  .openapi("AuctionListItem");

export const AuctionList = paginated(AuctionListItem).openapi("AuctionList");

export const AuctionOptions = z
  .object({
    options: z.array(
      z.object({
        auctionId: int(),
        auctionNumber: z.string().nullable(),
        clientId: int().nullable(),
        clientName: z.string().nullable(),
        label: z.string().openapi({ example: "AUC-001 — Acme Ltd" }),
      }),
    ),
  })
  .openapi("AuctionOptions");

export const AuctionDocumentTypes = z
  .object({
    documentTypes: z.array(
      z.object({ documentTypeId: int(), name: z.string(), fileNamePrefix: z.string() }),
    ),
    allowedExtensions: z.array(z.string()).openapi({ example: ["pdf", "docx"] }),
  })
  .openapi("AuctionDocumentTypes");

export const AuctionTodayList = z
  .array(
    z.object({
      clientId: int().nullable(),
      clientName: z.string().nullable(),
      auctionId: int(),
      auctionNumber: z.string().nullable(),
      auctionType: z.string().nullable(),
      startTime: z
        .string()
        .nullable()
        .openapi({ description: "Earliest lot start (`YYYY-MM-DDTHH:mm:ss`, IST), else the auction date." }),
      auctionDate: z.string().nullable().openapi({ description: "`YYYY-MM-DD`." }),
      status: z.enum(["live", "upcoming"]),
      catalogueUrl: z.string().nullable(),
      tncUrl: z.string().nullable(),
    }),
  )
  .openapi("AuctionTodayList");

export const AuctionCreated = z.object({ auctionId: int() }).openapi("AuctionCreated");

/* ------------------------------------------------------------------ */
/* Lots                                                                */
/* ------------------------------------------------------------------ */

/** PgLotRow in services/auctions-pg.service.ts. */
export const AuctionLot = z
  .object({
    lotId: int(),
    lotNumber: z.string().nullable(),
    quantity: z.number().nullable(),
    uom: z.string().nullable(),
    startBidPrice: z.number().nullable(),
    displayOrder: z.number().nullable(),
    status: int().nullable(),
    winnerUserId: int().nullable(),
    winingAmount: z.number().nullable().openapi({ description: "Winning amount (field name is misspelt in the API)." }),
    lotStartTime: TimeOfDay.nullable(),
    lotEndTime: TimeOfDay.nullable(),
    lotEffectiveEndTime: TimeOfDay.nullable()
      .optional()
      .openapi({ description: "Effective end time including extensions. Only on the single-lot endpoint." }),
    bidIncrement: z.number().nullable(),
    bidLimit: z.number().nullable(),
    isApproved: z.boolean().nullable(),
    reviewedAt: z.string().nullable(),
    reviewedBy: int().nullable(),
    reviewedByName: z.string().nullable(),
    winnerCompId: int().nullable().openapi({ description: "Winning bidder id." }),
    winnerName: z.string().nullable(),
    clientId: int(),
    auctionId: int(),
    materialLiftingDays: int().nullable(),
    plantLocationId: int().nullable(),
    materialLocationId: int().nullable(),
    plantLocationName: z.string().nullable(),
    materialLocationName: z.string().nullable(),
    loadingScope: z.string().nullable(),
    gstPercentage: z.number().nullable(),
    tcsPercentage: z.number().nullable(),
    remark: z.string().nullable(),
    updatedAt: z.string().nullable(),
    updatedByName: z.string().nullable(),
    emailedAt: z.string().nullable().openapi({ description: "When the lot confirmation was emailed to the winner." }),
    emailedByName: z.string().nullable(),
    bidCount: int(),
    bidderCount: int(),
    isActive: z.boolean().openapi({ description: "False for soft-withdrawn lots." }),
    isClosed: z.boolean().optional().openapi({ description: "Whether the lot's effective end is in the past." }),
    isReopened: z.boolean().openapi({ description: "Reopened by an admin: own end time, no stagger or extensions." }),
  })
  .openapi("AuctionLot");

export const AuctionLotList = paginated(AuctionLot).openapi("AuctionLotList");

const DocumentRef = z
  .object({ name: z.string(), uploadedAt: z.string(), downloadUrl: z.string() })
  .nullable();

/** Return of AuctionsService.getById. */
export const AuctionDetail = z
  .object({
    auctionId: int(),
    auctionNumber: z.string().nullable(),
    clientId: int(),
    clientName: z.string().nullable(),
    auctionType: z
      .string()
      .nullable()
      .openapi({ description: "Capitalised type, e.g. `Forward`, `Reverse`." }),
    auctionDate: z.string(),
    publishedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    isPublished: z.boolean(),
    isApproved: z.boolean(),
    isClosed: z.boolean(),
    isArchived: z.boolean(),
    isCanceled: z.boolean(),
    status: auctionStatusSchema,
    scheduleBucket: ScheduleBucket,
    canArchive: z.boolean(),
    canRestore: z.boolean(),
    canUnpublish: z
      .boolean()
      .openapi({ description: "Published, bidding has not started and no bidders are attached: Move to Draft is allowed." }),
    unpublishBlockedByBidders: z
      .boolean()
      .openapi({ description: "Move to Draft would be allowed, but bidders are still attached to lots." }),
    sealedWindowState: z
      .enum(["upcoming", "open", "closed"])
      .nullable()
      .openapi({ description: "Where now sits relative to the sealed-bid window; null without one." }),
    canEditSealedWindow: z
      .boolean()
      .openapi({ description: "Sealed-bid settings are editable any time the auction is draft or published — even while the window is open or after it has closed. Blocked once closed." }),
    sealedBidCount: z
      .number()
      .int()
      .openapi({ description: "Active (non-removed) sealed bids on this auction. Changing the sealed-bid window while this is greater than zero disables (soft-deletes) those bids." }),
    canCorrectStagger: z
      .boolean()
      .openapi({ description: "Published and live, with a positive stagger interval: lot staggering can be forced on/off via the stagger correction." }),
    canEditContent: z
      .boolean()
      .openapi({ description: "Draft, or published and not yet live (and not inside an open sealed-bid window) — documents are editable. Blocked once closed. See `canEditLots` for lot editability, `canEditSettings` for Auction Settings fields, and `canEditExecutionContent` for EMD / Attach Bidders." }),
    canEditLots: z
      .boolean()
      .openapi({ description: "Lot settings are editable any time before the auction closes (draft, archived, or published — including live). Once closed, a specific lot stays editable if that lot's own `isReopened` is true, independent of this auction-wide flag." }),
    canEditSettings: z
      .boolean()
      .openapi({ description: "Auction Settings fields with no other status-aware gate (auction number/type, published-at, no-bid extension rules, rank-based, IP restriction, start-bid-plus-increment) are editable any time before the auction closes. Blocked once closed." }),
    canEditExecutionContent: z
      .boolean()
      .openapi({ description: "EMD config and Attach Bidders are editable only while the auction is published; blocked while draft/archived/closed." }),
    hasAdditionalFields: z.boolean(),
    settings: z.object({
      emdAmount: z.number().nullable().openapi({ description: "Consolidated EMD amount." }),
      isSealedBid: z.boolean(),
      sealedBidDate: z.string().nullable(),
      sealedBidStartTime: TimeOfDay.nullable(),
      sealedBidEndTime: TimeOfDay.nullable(),
      isStartBidPricePlusIncrement: z.boolean().nullable(),
      ipRestriction: z.boolean().nullable(),
      isRankBased: z.boolean(),
      isNoBidExtension: z.boolean().nullable(),
      noBidExtensionInterval: int().nullable().openapi({ description: "Seconds." }),
      noBidExtensionCountMax: int().nullable(),
      isStaggered: z.boolean(),
      staggerInterval: int(),
    }),
    lotsTotal: int(),
    lotsPreview: z.array(AuctionLot).openapi({ description: "First 10 active lots." }),
    totalQty: z.number().nullable(),
    soldQty: z.number().nullable(),
    uom: z.string().nullable(),
    setupProgress: z.object({
      lotsLoaded: z.boolean(),
      catalogueUploaded: z.boolean(),
      currentCatalogue: DocumentRef,
      tncUploaded: z.boolean(),
      currentTnc: DocumentRef,
      lotEmdSet: z.boolean(),
      lotEmdCount: int(),
      biddersMapped: z.boolean(),
      lotsWithBidders: int(),
      additionalFieldsCount: int(),
    }),
  })
  .openapi("AuctionDetail");

export const AuctionDetailEnvelope = z.object({ auction: AuctionDetail }).openapi("AuctionDetailEnvelope");

const LotBidderRef = z.object({ bidderCompId: int(), bidderName: z.string().nullable() });

/** Return of AuctionsService.getLot. */
export const AuctionLotDetail = z
  .object({
    lot: AuctionLot.extend({
      isClosed: z.boolean(),
      items: z.array(
        z.object({
          id: int(),
          itemId: int().openapi({ description: "0 when the lot item has no linked item." }),
          itemName: z.string().nullable(),
          materialName: z.string().nullable(),
          materialDescription: z.string().nullable(),
          quantity: z.number().nullable(),
          uomId: int().nullable(),
          uom: z.string().nullable(),
          benchmarkMaterialLocationId: int().nullable(),
          benchmarkMaterial: z.string().nullable().openapi({ description: "`Material@@Location` label." }),
        }),
      ),
      mappedBidders: z.array(LotBidderRef),
      correctionWinnerCandidates: z
        .array(LotBidderRef.extend({ mappedToLot: z.boolean() }))
        .openapi({ description: "Active, non-blocked client bidders eligible as a settlement winner correction." }),
    }),
  })
  .openapi("AuctionLotDetail");

export const AuctionLotBids = paginated(
  z.object({
    id: int(),
    bidderId: int(),
    bidderName: z.string().nullable(),
    amount: z.number(),
    bidType: z.enum(["proxy", "manual"]),
    proxyAmount: z.number().openapi({ description: "Proxy ceiling; 0 for manual bids." }),
    placedAt: z.string().nullable(),
  }),
).openapi("AuctionLotBids");

const ParticipantShape = {
  bidderId: int(),
  companyName: z.string().nullable(),
  userId: int().nullable(),
  loginId: z.string().nullable(),
  isLoggedIn: z.boolean(),
  tncAccepted: z.boolean(),
};

export const AuctionLotBidBidders = z
  .array(
    z.object({
      ...ParticipantShape,
      rank: int().nullable().openapi({ description: "Live rank for rank-based auctions (sorted by rank); null otherwise." }),
    }),
  )
  .openapi("AuctionLotBidBidders");

export const AuctionParticipants = z.array(z.object(ParticipantShape)).openapi("AuctionParticipants");

const IdName = z.object({ id: int(), name: z.string().nullable() });

export const AuctionLotEditorOptions = z
  .object({
    plantLocations: z.array(IdName),
    materialLocations: z.array(IdName),
    uoms: z.array(z.object({ id: int(), code: z.string() })),
    benchmarks: z.array(
      z.object({ id: int(), label: z.string(), material: z.string(), location: z.string() }),
    ),
  })
  .openapi("AuctionLotEditorOptions");

export const AuctionLotCreated = z
  .object({ lotId: int() })
  .openapi("AuctionLotCreated");

export const AuctionLotsDeleted = z
  .object({ deleted: int() })
  .openapi("AuctionLotsDeleted");

/** AuctionLotImportStagingSessionView in lib/auction-lot-import-types.ts. */
export const AuctionLotImportStagingSession = z
  .object({
    stagingId: z.string(),
    auctionId: int(),
    expiresAt: z.string(),
    rows: z.array(
      z.object({
        rowNumber: int(),
        lotNumber: z.string(),
        displayOrder: z.number(),
        materialName: z.string(),
        startBidPrice: z.number(),
        bidIncrement: z.number(),
        bidLimit: z.number(),
        benchmarkMaterial: z.string().nullable(),
        benchmarkMaterialLocationId: int().nullable(),
        quantity: z.number(),
        uom: z.string(),
        lotStartTime: z.string(),
        lotEndTime: z.string(),
        fuzzyCandidate: z
          .union([z.literal(0), z.literal(1), z.literal(2)])
          .openapi({ description: "Item match confidence bucket from fuzzy matching." }),
        score: z.number(),
        suggestedItemIds: z.array(int()),
        selectedItemId: int().nullable(),
      }),
    ),
    items: z.array(z.object({ id: int(), name: z.string() })),
    benchmarks: z.array(z.object({ id: int(), label: z.string() })),
  })
  .openapi("AuctionLotImportStagingSession");

/* ------------------------------------------------------------------ */
/* Bidder pool / lot-bidder maps                                       */
/* ------------------------------------------------------------------ */

export const AuctionBidderPool = z
  .object({
    bidders: z.array(
      z.object({
        id: int().openapi({ description: "Lot-bidder map id (use as `:mapId`)." }),
        bidderCompId: int(),
        bidderName: z.string().nullable(),
        lotId: int().nullable(),
        isActive: z.boolean(),
      }),
    ),
  })
  .openapi("AuctionBidderPool");

export const AuctionBidderPoolAdded = z.object({ added: int() }).openapi("AuctionBidderPoolAdded");

/** LotBidderMapPreviewRow in services/auctions.service.ts. */
export const AuctionLotBidderMapPreviewRow = z
  .object({
    bidderId: int(),
    bidderName: z.string(),
    lotIds: z.array(int()),
    lotDisplayOrders: z.array(z.number()),
    lotDisplayOrderFrom: z.number().nullable(),
    lotDisplayOrderTo: z.number().nullable(),
    emdRequired: z.number(),
    alreadyBlocked: z
      .number()
      .optional()
      .openapi({ description: "Bidder's existing blocked amount on this auction before this attach. Interactive preview only." }),
    combinedEmdRequired: z
      .number()
      .optional()
      .openapi({
        description:
          "EMD required for the bidder's existing + newly selected lots combined — what the Full block is checked against on submit. Interactive preview only.",
      }),
    emdAvailable: z.number(),
    isEmdWithClient: z.boolean(),
    emdAmount: z
      .number()
      .nullable()
      .openapi({ description: "Additional EMD that will be blocked by this attach (combined requirement minus already-blocked amount; display only); null when EMD is with the client." }),
    error: z.string().nullable().openapi({ description: "Per-row validation error; row cannot be submitted when set." }),
    rowNumber: int().optional().openapi({ description: "1-based Excel row (bulk import only)." }),
  })
  .openapi("AuctionLotBidderMapPreviewRow");

export const AuctionLotBidderMapPreview = z
  .object({ rows: z.array(AuctionLotBidderMapPreviewRow) })
  .openapi("AuctionLotBidderMapPreview");

export const AuctionLotCorrectionEmdPreview = z
  .object({
    emdRequired: z
      .number()
      .openapi({ description: "Additional EMD this lot would need blocked from the bidder's wallet." }),
    emdAvailable: z.number().openapi({ description: "Bidder's current live available EMD balance." }),
    alreadyBlocked: z
      .number()
      .openapi({ description: "Bidder's current total Blocked EMD on this auction (held-for-winning included)." }),
  })
  .openapi("AuctionLotCorrectionEmdPreview");

export const AuctionLotBidderMapImport = z
  .object({
    rows: z.array(AuctionLotBidderMapPreviewRow),
    skipped: z.array(z.object({ rowNumber: int(), reason: z.string() })),
  })
  .openapi("AuctionLotBidderMapImport");

export const AuctionLotBidderMapSubmitResult = z
  .object({
    mapped: int(),
    skipped: int(),
    results: z.array(
      z.object({
        bidderId: int(),
        status: z.enum(["mapped", "skipped", "error"]),
        error: z.string().nullable(),
        message: z.string().nullable(),
      }),
    ),
  })
  .openapi("AuctionLotBidderMapSubmitResult");

export const AuctionLotBidderMapRemoveResult = z
  .object({ removed: int(), requestedPairs: int() })
  .openapi("AuctionLotBidderMapRemoveResult");

export const AuctionLotBidderSummary = z
  .object({
    lots: z.array(z.object({ lotId: int(), lotNumber: z.string().nullable(), bidderCount: int() })),
  })
  .openapi("AuctionLotBidderSummary");

export const AuctionLotBidderMapList = paginated(
  z.object({
    lotId: int(),
    lotNumber: z.string().nullable(),
    displayOrder: z.number().nullable(),
    bidders: z.array(
      LotBidderRef.extend({
        emdReleased: z
          .boolean()
          .describe(
            "True when this lot's EMD was released at an earlier close and the bidder has not been re-attached to the lot since (reopened auction). They cannot bid on the lot until re-attached.",
          ),
      }),
    ),
  }),
).openapi("AuctionLotBidderMapList");

/* ------------------------------------------------------------------ */
/* EMD ranges                                                          */
/* ------------------------------------------------------------------ */

export const AuctionEmdRange = z
  .object({
    lotEmdId: int(),
    lotDisplayOrderFrom: z.number(),
    lotDisplayOrderTo: z.number(),
    emd: z.number(),
    displayOrder: int().nullable(),
  })
  .openapi("AuctionEmdRange");

export const AuctionEmdRanges = z
  .object({ ranges: z.array(AuctionEmdRange), consolidatedEmd: z.number().nullable() })
  .openapi("AuctionEmdRanges");

export const AuctionEmdRangesReplaced = z
  .object({ ok: z.literal(true), ranges: z.array(AuctionEmdRange), consolidatedEmd: z.number() })
  .openapi("AuctionEmdRangesReplaced");

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export const AuctionDocument = z
  .object({
    id: int(),
    documentTypeId: int(),
    documentTypeName: z.string(),
    fileName: z.string(),
    fileSize: z.number().nullable().openapi({ description: "Currently always null." }),
    isActive: z.boolean(),
    createDatetime: z.string(),
    uploadedByName: z.string().nullable(),
    downloadUrl: z.string().openapi({ description: "Signed R2 download URL." }),
  })
  .openapi("AuctionDocument");

export const AuctionDocumentList = paginated(AuctionDocument).openapi("AuctionDocumentList");

export const AuctionDocumentUploaded = z
  .object({ id: int(), documentTypeId: int() })
  .openapi("AuctionDocumentUploaded");

/* ------------------------------------------------------------------ */
/* Settlement: approvals / no-bid lots / winners                       */
/* ------------------------------------------------------------------ */

export const AuctionApprovalLots = z
  .object({
    lots: z.array(
      z.object({
        lotId: int(),
        lotNumber: z.string().nullable(),
        displayOrder: z.number().nullable(),
        quantity: z.number().nullable(),
        uom: z.string().nullable(),
        winingAmount: z.number().nullable(),
        winnerName: z.string().nullable(),
        isApproved: z.boolean().nullable().openapi({ description: "null = pending, true = approved, false = rejected." }),
        reviewedAt: z.string().nullable(),
        reviewedBy: int().nullable(),
      }),
    ),
  })
  .openapi("AuctionApprovalLots");

export const AuctionNoBidLots = z
  .object({
    lots: z.array(
      z.object({
        lotId: int(),
        lotNumber: z.string().nullable(),
        displayOrder: z.number().nullable(),
        startTime: TimeOfDay.nullable(),
        endTime: TimeOfDay.nullable(),
        quantity: z.number().nullable(),
        uom: z.string().nullable(),
        startBidPrice: z.number().nullable(),
        noBidExtensionCountMax: int().nullable(),
        noBidExtensionCount: int(),
        status: z.enum(["Active", "Stopped"]),
        stoppedAt: z.string().nullable(),
        stoppedByName: z.string().nullable(),
        isSelectable: z.boolean().openapi({ description: "True when `status` is `Active`." }),
      }),
    ),
  })
  .openapi("AuctionNoBidLots");

export const AuctionNotifyWinnersResult = z
  .object({ ok: z.literal(true), emailedBidderCount: int(), lotCount: int() })
  .openapi("AuctionNotifyWinnersResult");

/* ------------------------------------------------------------------ */
/* Catalogue notification                                              */
/* ------------------------------------------------------------------ */

export const AuctionCatalogueNotificationPreview = z
  .object({
    clientName: z.string(),
    auctionNumber: z.string(),
    auctionDate: z.string(),
    plantLocationsSummary: z.string(),
    catalogueUploaded: z.boolean(),
    catalogueUrl: z.string().nullable(),
    lastTriggeredAt: z.string().nullable(),
    eligibleBidders: z.array(
      z.object({ bidderId: int(), companyName: z.string(), contactEmail: z.string() }),
    ),
  })
  .openapi("AuctionCatalogueNotificationPreview");

export const AuctionCatalogueNotificationHistory = z
  .object({
    rows: z.array(
      z.object({
        id: int(),
        triggeredAt: z.string(),
        catalogueType: z.enum(["new", "revised"]),
        materialsSummary: z.string(),
        plantLocationsSummary: z.string(),
        sentByName: z.string().nullable(),
        recipientCount: int(),
      }),
    ),
  })
  .openapi("AuctionCatalogueNotificationHistory");

export const AuctionCatalogueNotificationSent = z
  .object({ ok: z.literal(true), recipientCount: int() })
  .openapi("AuctionCatalogueNotificationSent");

/* ------------------------------------------------------------------ */
/* Additional fields                                                   */
/* ------------------------------------------------------------------ */

const AdditionalFieldDef = z.object({
  fieldId: int(),
  label: z.string(),
  dataType: z.enum(["text", "number", "date", "boolean"]),
  isActive: z.boolean(),
  displayOrder: int(),
});

export const AuctionAdditionalFieldsOverview = z
  .object({
    auctionFields: z.array(AdditionalFieldDef.extend({ valueId: int(), value: z.string().nullable() })),
    auctionFieldOptions: z
      .array(AdditionalFieldDef)
      .openapi({ description: "Active auction-scope client fields (label dropdown)." }),
    lotFields: z
      .array(AdditionalFieldDef)
      .openapi({ description: "Lot-scope fields selected for this auction (dynamic lot columns)." }),
    clientHasFields: z.boolean(),
  })
  .openapi("AuctionAdditionalFieldsOverview");

export const AuctionAdditionalFieldLots = paginated(
  z.object({
    lotId: int(),
    lotNumber: z.string(),
    displayOrder: z.string(),
    values: z
      .record(z.string().nullable())
      .openapi({ description: "fieldId → stored value (ISO for dates); a missing key means no value row." }),
  }),
).openapi("AuctionAdditionalFieldLots");

const ImportIssue = z.object({
  rowNumber: int(),
  kind: z.enum(["error", "skipped", "uploaded"]),
  reason: z.string(),
  fieldErrors: z.record(z.array(z.string())).optional(),
});

const ImportResultShape = {
  imported: int(),
  failed: int(),
  skipped: int(),
  issues: z.array(ImportIssue),
  issuesTruncated: z.boolean().optional(),
};

export const AuctionAdditionalFieldsImportResult = z
  .object({ ...ImportResultShape, created: int(), updated: int(), deleted: int() })
  .openapi("AuctionAdditionalFieldsImportResult");

export const AuctionAdditionalFieldsImportJobAccepted = z
  .object({ jobId: int() })
  .openapi("AuctionAdditionalFieldsImportJobAccepted");

export const AuctionAdditionalFieldsImportJobStatus = z
  .object({
    id: int(),
    auctionId: int(),
    status: z.enum(["queued", "running", "done", "failed"]),
    result: AuctionAdditionalFieldsImportResult.nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("AuctionAdditionalFieldsImportJobStatus");

/* ------------------------------------------------------------------ */
/* SSE payloads (documented in descriptions; exported for reuse)       */
/* ------------------------------------------------------------------ */

export const AuctionLotImportSseStream = z
  .string()
  .openapi({
    description:
      "Server-Sent Events stream. Events: `progress` `{ phase: 'parse'|'import', processed, total, percent, label }`; " +
      "`complete` `{ imported, failed, skipped, withdrawn, issues[], issuesTruncated? }`; " +
      "`needs_review` `{ stagingId, parsed, failed, skipped, total, issues[], issuesTruncated? }`; " +
      "`error` `{ message, code? }`. Each issue is `{ rowNumber, kind: 'error'|'skipped'|'uploaded', reason, fieldErrors? }`.",
    example:
      'event: progress\ndata: {"phase":"parse","processed":10,"total":40,"percent":25,"label":"Parsing rows"}\n\n',
  });


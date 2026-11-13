import { z } from "zod";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { auctionLotWriteSchema } from "../../lib/auction-lot-write-schema.js";
import {
  auctionDocumentsListQuerySchema,
  auctionListFilterSchema,
  createAuctionSchema,
  lotCorrectionSchema,
  patchAuctionSchema,
  reopenLotsCorrectionSchema,
  sendCatalogueNotificationSchema,
  staggerCorrectionSchema,
} from "../../lib/auctions/schemas.js";
import { entityOptionIdsQuerySchema, entityOptionsQuerySchema } from "../../lib/options-query.js";
import { BinaryFile, ErrorBody, IdParam, OkBody, OptionIdsResult, ValidationErrorBody } from "../common.js";
import { documentRouter, type ResponseDoc } from "../define.js";
import {
  AuctionAdditionalFieldLots,
  AuctionAdditionalFieldsImportResult,
  AuctionAdditionalFieldsOverview,
  AuctionApprovalLots,
  AuctionBidderPool,
  AuctionBidderPoolAdded,
  AuctionCatalogueNotificationHistory,
  AuctionCatalogueNotificationPreview,
  AuctionCatalogueNotificationSent,
  AuctionCreated,
  AuctionDetailEnvelope,
  AuctionDocumentList,
  AuctionDocumentTypes,
  AuctionDocumentUploaded,
  AuctionEmdRanges,
  AuctionEmdRangesReplaced,
  AuctionList,
  AuctionLotBidBidders,
  AuctionLotBidderMapImport,
  AuctionLotBidderMapList,
  AuctionLotBidderMapPreview,
  AuctionLotBidderMapRemoveResult,
  AuctionLotBidderMapSubmitResult,
  AuctionLotBidderSummary,
  AuctionLotBids,
  AuctionLotCorrectionEmdPreview,
  AuctionLotCreated,
  AuctionLotDetail,
  AuctionLotEditorOptions,
  AuctionLotImportSseStream,
  AuctionLotImportStagingSession,
  AuctionLotList,
  AuctionLotsDeleted,
  AuctionNoBidLots,
  AuctionNotifyWinnersResult,
  AuctionOptions,
  AuctionParticipants,
  AuctionStats,
  AuctionTodayList,
} from "../responses/auctions.js";

// Docs for src/routes/auctions.ts — see docs/api/README.md.
const r = documentRouter("/auctions");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* Shared responses ------------------------------------------------------- */

/** `handleAuctionError`: AuctionNotFoundError → 404 (also used for missing lots / rows). */
const notFound: ResponseDoc = {
  description: "Auction (or the referenced lot) not found.",
  schema: ErrorBody,
};

/** `handleAuctionError`: AuctionValidationError → 400 with or without `fieldErrors`. */
const businessError = (description: string): ResponseDoc => ({
  description:
    `${description} Also returned for an invalid path id and for request-schema errors. ` +
    "Business-rule errors are `{ error }`, or `{ error, fieldErrors }` when tied to fields.",
  schema: z.union([ValidationErrorBody, ErrorBody]),
});

const xlsxFile = (description: string): ResponseDoc => ({ description, schema: BinaryFile, contentType: XLSX });

const importSse = (description: string): ResponseDoc => ({
  description,
  schema: AuctionLotImportSseStream,
  contentType: "text/event-stream",
});

const xlsxUploadBody = z.object({ file: BinaryFile.openapi({ description: ".xlsx workbook." }) });
const xlsxUpload400 = businessError(
  `File missing ("${AuctionsValidationMessages.MISSING_IMPORT_FILE}"), not .xlsx, or the auction is not in a state that allows this import.`,
);

/* Request schemas recreated from src/routes/auctions.ts ------------------ */

// listQuerySchema in src/routes/auctions.ts
const listQuerySchema = z.object({
  search: z.string().optional(),
  filter: auctionListFilterSchema.optional(),
  phase: z.enum(["creation", "execution", "settlement"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  year: z.coerce.number().int().min(2000).max(3000).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  dateField: z.enum(["auctionDate", "publishedAt"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
  sortBy: z.enum(["auctionDate", "publishedAt", "auctionNumber", "clientName", "status"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

// statsQuerySchema in src/routes/auctions.ts
const statsQuerySchema = listQuerySchema.omit({
  filter: true,
  phase: true,
  page: true,
  pageSize: true,
  sortBy: true,
  sortOrder: true,
});

// lotsListQuerySchema in src/routes/auctions.ts
const lotsListQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
  sortBy: z
    .enum([
      "displayOrder",
      "lotNumber",
      "startTime",
      "endTime",
      "quantity",
      "startBidPrice",
      "bidIncrement",
      "winningAmount",
      "updatedAt",
      "reviewedAt",
    ])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  includeInactive: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .describe("Include soft-withdrawn lots."),
});

// lotBidderMapListQuerySchema in src/routes/auctions.ts
const lotBidderMapListQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
  sortBy: z.enum(["displayOrder", "lotNumber"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

// Inline page/pageSize parsing of GET /:id/lots/:lotId/bids (Number(...) || default; not validated).
const lotBidsQuerySchema = z.object({
  page: z.coerce.number().int().optional().describe("Defaults to 1."),
  pageSize: z.coerce.number().int().optional().describe("Defaults to 10."),
});

// lotImportStagingConfirmSchema in src/routes/auctions.ts
const lotImportStagingConfirmSchema = z.object({
  selections: z
    .array(
      z.object({
        rowNumber: z.number().int().positive(),
        itemId: z.number().int().positive(),
        benchmarkMaterialLocationId: z.number().int().positive().nullable().optional(),
      }),
    )
    .min(1),
});

// lotImportStagingExportSchema in src/routes/auctions.ts
const lotImportStagingExportSchema = z.object({
  selections: z.array(
    z.object({
      rowNumber: z.number().int().positive(),
      itemId: z.number().int().positive().nullable().optional(),
      benchmarkMaterialLocationId: z.number().int().positive().nullable().optional(),
    }),
  ),
});

const stagingParams = z.object({
  id: IdParam.shape.id,
  stagingId: z.string().openapi({ param: { name: "stagingId", in: "path" }, description: "Staging session id (UUID)." }),
});

// auctionDocumentFieldsSchema in src/routes/auctions.ts (+ multer `file` field)
const auctionDocumentUploadBody = z.object({
  documentTypeId: z.coerce.number().int().positive(),
  file: BinaryFile.openapi({ description: "Document file (pdf / docx)." }),
});

// Additional-fields schemas in src/routes/auctions.ts
const additionalFieldValueSchema = z.string().max(4000).nullable().optional();
const additionalFieldsLotsQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
});
const additionalFieldAuctionRowSchema = z.object({
  fieldId: z.number().int().positive(),
  value: additionalFieldValueSchema,
});
const additionalFieldLotValuesSchema = z.object({
  values: z
    .array(z.object({ fieldId: z.number().int().positive(), value: additionalFieldValueSchema }))
    .max(200),
});

const bidderIdsBody = z.object({ bidderIds: z.array(z.number().int().positive()).min(1) });
const bidderLotPairsBody = z.object({
  bidderIds: z.array(z.number().int().positive()).min(1),
  lotIds: z.array(z.number().int().positive()).min(1),
});
const lotIdsBody = z.object({ lotIds: z.array(z.number().int().positive()).min(1) });
const lotSelectionBody = z.object({
  lotIds: z.array(z.number().int().positive()).optional(),
  all: z.boolean().optional().describe("Apply to every lot of the auction (takes precedence over `lotIds`)."),
});

// Inline PUT /:id/emd-ranges schema in src/routes/auctions.ts
const replaceEmdRangesBody = z
  .object({
    consolidatedEmd: z.number().positive(),
    ranges: z
      .array(
        z.object({
          displayOrder: z.number().int().positive().nullable().optional(),
          lotDisplayOrderFrom: z.number(),
          lotDisplayOrderTo: z.number(),
          emd: z.number().positive(),
        }),
      )
      .min(1),
  })
  .describe("The sum of range EMDs must be at least `consolidatedEmd`.");

/* List / lookup ---------------------------------------------------------- */

r.get("/stats", {
  summary: "Auction counts",
  description:
    "Auction count for every list filter (`all_active`, each status and each schedule bucket). " +
    "`year` + `month` together restrict to that month; `dateFrom`/`dateTo` filter on `dateField` (default `auctionDate`).",
  query: statsQuerySchema,
  responses: { 200: AuctionStats },
});

r.get("/options", {
  summary: "Auction options for a picker",
  description:
    "Non-archived auctions for select inputs, newest first, optionally for one client. " +
    "Empty `q` returns up to `limit`; ids in `ids` are always included.",
  query: entityOptionsQuerySchema.extend({ clientId: z.coerce.number().int().positive().optional() }),
  responses: { 200: AuctionOptions },
});

r.get("/options/ids", {
  summary: "Auction ids matching a search (select all)",
  query: entityOptionIdsQuerySchema.extend({ clientId: z.coerce.number().int().positive().optional() }),
  responses: { 200: OptionIdsResult },
});

r.get("/", {
  summary: "List auctions",
  description:
    "Paginated auction list. `filter` defaults to `all_active`; `phase` narrows to creation (draft/archived), " +
    "execution (published) or settlement (closed). `year` + `month` together restrict to that month.",
  query: listQuerySchema,
  responses: { 200: AuctionList },
});

r.get("/document-types", {
  summary: "List auction document types",
  description: "Active document types (catalogue, T&C, …) and the allowed upload extensions.",
  responses: { 200: AuctionDocumentTypes },
});

r.get("/today", {
  summary: "Today's auctions",
  description:
    "Published auctions dated today (IST) that have not yet ended, for the admin dashboard. " +
    "`status` is `upcoming` before the earliest lot start and `live` afterwards. Catalogue / T&C are signed URLs.",
  responses: { 200: AuctionTodayList },
});

/* Auction CRUD / lifecycle ---------------------------------------------- */

r.post("/", {
  summary: "Create auction",
  description:
    "Creates a `draft` auction. The auction number is generated from the client's prefix when not given and must be " +
    "unique per client. The client's active T&C is copied onto the auction (best effort).",
  body: createAuctionSchema,
  responses: {
    201: { description: "Created auction id.", schema: AuctionCreated },
    400: businessError("Invalid settings, missing client auction prefix, or duplicate auction number."),
  },
});

r.get("/:id", {
  summary: "Get auction",
  description: "Auction header, settings, permission flags (`canEditContent`, `canArchive`, …), lot preview and setup progress.",
  params: IdParam,
  responses: { 200: AuctionDetailEnvelope, 404: notFound },
});

r.patch("/:id", {
  summary: "Update auction settings",
  description:
    "Partial update of auction settings. Allowed at any auction status (draft, published — including live — or closed). " +
    "Writes apply immediately — a published auction stays published and does not need re-publishing. Sealed-bid settings " +
    "(date/start/end) can be changed at any time the auction is draft or published — even while the window is open or " +
    "after it has closed, moving it forward to a later time or a future day. If any sealed bids exist on the auction when " +
    "the window actually changes, they are disabled (soft-deleted) as part of the same update, so bidders rebid under the " +
    "new schedule. The sealed-bid date can't be before today or after the auction date — its time of day is otherwise " +
    "independent of the auction's/lots' schedule. " +
    "`auctionDate` can only change when no lot on the auction has any bids — remove all bids from every lot first (via the lot-correction " +
    "`remove_all_bids` type), then retry. Changing the date of a closed (necessarily bid-free) auction republishes it on the new date " +
    "(`status` back to `published`, `closedAt` cleared, and any stale no-bid-extension state on its lots reset). The consolidated EMD " +
    "amount can only change while the auction is published or closed (not draft/archived), and only while no bidder is attached to any " +
    "lot on the auction (detach everyone first) — unlike a per-range amount, it has no narrower scope to check. `clientId` cannot be " +
    "changed. Changing no-bid extension settings is synced onto the lots.",
  params: IdParam,
  body: patchAuctionSchema,
  responses: {
    200: OkBody,
    400: businessError(
      "Invalid settings, duplicate auction number, auction date change with existing bids, EMD amount change while not published/closed, or while any bidder is attached.",
    ),
    404: notFound,
  },
});

r.post("/:id/publish", {
  summary: "Publish auction",
  description:
    "Moves a `draft` auction to `published`. Draft-only — a published auction stays published without needing to be " +
    "re-published after edits (settings/lot writes already apply immediately). Requires at least one lot, an uploaded " +
    "catalogue and T&C, a valid sealed-bid window (if enabled), and an earliest lot start still in the future.",
  params: IdParam,
  responses: {
    200: OkBody,
    400: businessError("Auction is not draft, or publish preconditions not met."),
    404: notFound,
  },
});

r.post("/:id/unpublish", {
  summary: "Move auction to draft",
  description:
    "Moves a `published` auction back to `draft`. Only allowed before bidding starts (sealed-bid window not yet open and no lot started) and once every bidder is detached from the lots. Edits never unpublish an auction; this is the only way.",
  params: IdParam,
  responses: { 200: OkBody, 400: businessError("Auction is not published, bidding has started, or bidders are still attached."), 404: notFound },
});

r.post("/:id/archive", {
  summary: "Archive auction",
  description: "Sets status to `archived`. Only allowed before the auction goes live.",
  params: IdParam,
  responses: { 200: OkBody, 400: businessError("Auction cannot be archived in its current state."), 404: notFound },
});

r.post("/:id/restore", {
  summary: "Restore archived auction",
  description: "Moves an `archived` auction back to `draft`.",
  params: IdParam,
  responses: { 200: OkBody, 400: businessError("Auction is not archived."), 404: notFound },
});

/* Lots ------------------------------------------------------------------- */

r.get("/:id/lots", {
  summary: "List auction lots",
  description: "Paginated lots, searchable by lot number or display order. Withdrawn lots only with `includeInactive`.",
  params: IdParam,
  query: lotsListQuerySchema,
  responses: { 200: AuctionLotList, 404: notFound },
});

r.get("/:id/lots/import/template", {
  summary: "Download lot import template",
  description: "Excel template for bulk lot import, prefilled with the auction's client masters.",
  params: IdParam,
  responses: { 200: xlsxFile("Lot import template (.xlsx)."), 404: notFound },
});

r.get("/:id/lots/export", {
  summary: "Export current lots",
  description:
    "All active lots, in the same column format as the lot import template, pre-filled with current values, so " +
    "the file can be edited in Excel and re-imported as-is to apply bulk edits.",
  params: IdParam,
  responses: { 200: xlsxFile("Current lots (.xlsx), formatted for re-import."), 404: notFound },
});

r.get("/:id/lots/editor-options", {
  summary: "Lot editor options",
  description: "Client plant/material locations, UOMs and benchmark material-locations for the lot editor.",
  params: IdParam,
  responses: { 200: AuctionLotEditorOptions, 404: notFound },
});

r.post("/:id/lots/import", {
  summary: "Import lots from Excel",
  description:
    "Uploads an .xlsx and streams progress as Server-Sent Events. Rows are upserted by lot; existing lots missing " +
    "from the file are withdrawn. If some rows need an item match, the stream ends with `needs_review` and a " +
    "`stagingId` (see the staging endpoints); otherwise it ends with `complete`. When lots changed on a published " +
    "auction it stays published. Failures after streaming starts arrive as an `error` event. " +
    "Allowed any time before the auction closes.",
  params: IdParam,
  body: xlsxUploadBody,
  responses: {
    200: importSse("SSE stream with `progress`, then `complete` | `needs_review` | `error`."),
    400: xlsxUpload400,
    404: notFound,
  },
});

r.get("/:id/lots/import/staging/:stagingId", {
  summary: "Get lot import staging session",
  description:
    "Rows of a lot import awaiting item matching, with fuzzy-match suggestions, the client's items and benchmark " +
    "options. Sessions belong to the uploading user and expire after 2 hours.",
  params: stagingParams,
  responses: {
    200: AuctionLotImportStagingSession,
    400: businessError("Invalid ids, or the auction content is no longer editable."),
    404: { description: "Auction or staging session not found.", schema: ErrorBody },
    410: { description: "Staging session expired (it is deleted).", schema: ErrorBody },
  },
});

r.post("/:id/lots/import/staging/:stagingId/confirm", {
  summary: "Confirm staged lot import",
  description:
    "Applies the item (and optional benchmark) selection for each staged row and imports the lots, streaming " +
    "progress as Server-Sent Events ending in `complete` (or `error`, e.g. expired session). " +
    "A published auction stays published.",
  params: stagingParams,
  body: lotImportStagingConfirmSchema,
  responses: {
    200: importSse("SSE stream with `progress`, then `complete` | `error`."),
    400: businessError("Invalid ids/body, or the auction content is no longer editable."),
    404: notFound,
  },
});

r.post("/:id/lots/import/staging/:stagingId/export", {
  summary: "Export lot import staging session",
  description:
    "Exports the staged rows plus the posted (possibly partial, unconfirmed) item/benchmark selections in the " +
    "same column format as the lot import template, so review can be resumed later via a normal re-import. Rows " +
    "with no selection yet are exported with a blank Item ID / Benchmark Material.",
  params: stagingParams,
  body: lotImportStagingExportSchema,
  responses: {
    200: xlsxFile("Staging session rows (.xlsx), formatted for re-import."),
    400: businessError("Invalid ids/body, or the auction content is no longer editable."),
    404: { description: "Auction or staging session not found.", schema: ErrorBody },
    410: { description: "Staging session expired (it is deleted).", schema: ErrorBody },
  },
});

r.post("/:id/lots", {
  summary: "Create lot",
  description:
    "Adds a lot (with its item). Allowed any time before the auction closes (draft, archived, or published — including live, " +
    "e.g. to add a lot mid-auction). The body is validated against the auction's " +
    "type (increment/decrement wording, bid-limit rules) and date (lot schedule). A published auction stays published.",
  params: IdParam,
  body: auctionLotWriteSchema,
  responses: {
    201: { description: "Created lot.", schema: AuctionLotCreated },
    400: businessError("Invalid lot, or auction closed."),
    404: notFound,
  },
});

r.post("/:id/lots/:lotId/withdraw", {
  summary: "Withdraw lot",
  description:
    "Soft-withdraws a lot (keeps its display order, marks it inactive). Allowed any time before the auction closes. " +
    "The last active lot of a published auction cannot be withdrawn; move the auction to draft first.",
  responses: {
    200: OkBody,
    400: businessError("Lot already withdrawn, auction closed, or (for the last active lot) auction not draft."),
    404: notFound,
  },
});

r.delete("/:id/lots", {
  summary: "Delete all lots",
  description: "Deletes every lot of the auction. Draft auctions only; a published auction must be moved to draft first.",
  params: IdParam,
  responses: { 200: AuctionLotsDeleted, 400: businessError("Auction not draft."), 404: notFound },
});

r.get("/:id/lots/:lotId", {
  summary: "Get lot",
  description: "Active lot with items, mapped bidders, settlement winner-correction candidates and effective end time.",
  responses: { 200: AuctionLotDetail, 404: notFound },
});

r.get("/:id/lots/:lotId/bids", {
  summary: "List lot bids",
  description: "Paginated bid history: best amount first (highest for forward, lowest for reverse), then oldest.",
  query: lotBidsQuerySchema,
  responses: { 200: AuctionLotBids, 404: notFound },
});

r.get("/:id/lots/:lotId/bidders", {
  summary: "List lot bidders",
  description:
    "Distinct bidders who bid on the lot with login and T&C status. Rank-based auctions are ordered by live rank; others by name with `rank: null`.",
  responses: { 200: AuctionLotBidBidders, 404: notFound },
});

r.patch("/:id/lots/:lotId", {
  summary: "Update lot",
  description:
    "Full replace of the lot's editable fields (same body as create). Allowed any time before the auction closes; " +
    "a published auction stays published.",
  body: auctionLotWriteSchema,
  responses: {
    200: OkBody,
    400: businessError("Invalid lot, or auction closed."),
    404: notFound,
  },
});

/* Corrections ------------------------------------------------------------ */

r.post("/:id/lots/:lotId/corrections", {
  summary: "Apply lot correction",
  description:
    "`remove_all_bids` / `remove_winning_bid`: execution phase while live — then pushes a live lot delta. " +
    "`reopen_lot`: reopens a closed lot with a new end time (settlement, or execution while live). Settlement reopen " +
    "is only allowed on the auction's own scheduled date. " +
    "`update_lot`: settlement only — corrects winner, winning amount, quantity, UOM, plant location and/or material " +
    "location. When the winner actually changes, `isEmdWithClient` is required: it decides whether the new winner's " +
    "EMD is blocked from their wallet (checked against their live available balance at this moment, not anything tied " +
    "to the auction's close date) or held by the client. The previous winner's held EMD for this lot's range is " +
    "released or reduced in the same transaction. A live snapshot is broadcast afterwards.",
  body: lotCorrectionSchema,
  responses: {
    200: OkBody,
    400: businessError(
      "Correction not allowed in the current phase, invalid values, an unknown UOM or a plant/material location not " +
        "belonging to the client, `isEmdWithClient` missing on a winner change, or the new winner's wallet has " +
        "insufficient available EMD.",
    ),
    404: notFound,
  },
});

r.get("/:id/lots/:lotId/corrections/emd-preview", {
  summary: "Preview EMD for a winner correction",
  description:
    "Read-only: the additional EMD `bidderId` would need blocked from their wallet to become this lot's winner, their " +
    "current live available balance, and their current total Blocked on this auction. Shown before confirming an " +
    "`update_lot` winner correction; never blocks or releases anything itself.",
  query: z.object({ bidderId: z.coerce.number().int().positive() }),
  responses: {
    200: AuctionLotCorrectionEmdPreview,
    400: businessError("Invalid lot or bidder id."),
    404: notFound,
  },
});

r.post("/:id/corrections/stagger", {
  summary: "Correct lot staggering",
  description:
    "Forces lot staggering on or off for this one live auction, overriding the client's default without changing it. " +
    "Only available while the auction is published and live. Staggering has no in-memory state, so the override is picked up " +
    "by the very next no-bid or last-bid extension; it does not retroactively undo cascades already applied. Broadcasts a live snapshot.",
  params: IdParam,
  body: staggerCorrectionSchema,
  responses: {
    200: OkBody,
    400: businessError("Auction not published and live."),
    404: notFound,
  },
});

r.post("/:id/corrections/reopen-lots", {
  summary: "Reopen lots",
  description:
    "Reopens closed lots in settlement (auction closed) or execution (auction live). In settlement, this republishes " +
    "the auction and is only allowed on the auction's own scheduled date (Asia/Kolkata calendar day); the execution " +
    "(live) path has no such date restriction. Reopened lots run on their own end time, outside lot staggering and " +
    "with no extensions. Broadcasts a live snapshot.",
  params: IdParam,
  body: reopenLotsCorrectionSchema,
  responses: {
    200: OkBody,
    400: businessError(
      "Auction not closed/live, settlement reopen attempted on a day other than the auction date, or invalid lots.",
    ),
    404: notFound,
  },
});

/* Bidder pool / lot-bidder mapping -------------------------------------- */

r.get("/:id/bidder-pool", {
  summary: "List auction bidder pool",
  description: "Active lot-bidder map entries of the auction.",
  params: IdParam,
  responses: { 200: AuctionBidderPool, 404: notFound },
});

r.get("/:id/participants", {
  summary: "List auction participants",
  description: "Bidders mapped to the auction with login id, logged-in state and T&C acceptance (dashboard modal).",
  params: IdParam,
  responses: { 200: AuctionParticipants, 404: notFound },
});

r.delete("/:id/bidder-pool/:mapId", {
  summary: "Remove bidder pool entry",
  description: "Deactivates one lot-bidder map entry. Allowed any time before the auction closes.",
  responses: { 200: OkBody, 400: businessError("Auction closed."), 404: notFound },
});

r.post("/:id/bidder-pool", {
  summary: "Add bidders to pool",
  description: "Adds verified bidders to the auction pool (skips ones already present). Allowed any time before the auction closes.",
  params: IdParam,
  body: bidderIdsBody,
  responses: {
    201: { description: "Number of entries added.", schema: AuctionBidderPoolAdded },
    400: businessError("Unverified bidder, or auction closed."),
    404: notFound,
  },
});

r.put("/:id/lots/:lotId/bidders", {
  summary: "Set lot bidders",
  description: "Replaces the bidders mapped to a lot. Bidders must be verified; allowed any time before the auction closes.",
  body: z.object({ bidderIds: z.array(z.number().int().positive()) }),
  responses: { 200: OkBody, 400: businessError("Unverified bidder, or auction closed."), 404: notFound },
});

r.post("/:id/lot-bidder-maps/bulk", {
  summary: "Bulk map bidders to lots",
  description: "Maps verified bidders to several lots in one call. Allowed any time before the auction closes.",
  params: IdParam,
  body: z.object({
    mappings: z
      .array(
        z.object({
          lotId: z.number().int().positive(),
          bidderIds: z.array(z.number().int().positive()).min(1),
        }),
      )
      .min(1),
  }),
  responses: { 200: OkBody, 400: businessError("Unverified bidder, or auction closed."), 404: notFound },
});

r.get("/:id/lot-bidder-map/template", {
  summary: "Download lot bidder map template",
  params: IdParam,
  responses: { 200: xlsxFile("Lot bidder map import template (.xlsx)."), 404: notFound },
});

r.get("/:id/lot-bidder-map/export", {
  summary: "Export current lot bidder map",
  description:
    "Every active bidder-lot attachment, in the same column format as the import template, so the file can be re-imported " +
    "as-is (e.g. to re-attach the same bidders after a reopen). Rows are grouped by (bidder, isEmdWithClient); a bidder split " +
    "across both flags produces two rows. Includes bidders whose EMD was already released as a non-winner, since they remain " +
    "attached (only `emdReleased` is set) until re-attached.",
  params: IdParam,
  responses: { 200: xlsxFile("Current lot bidder map (.xlsx), formatted for re-import."), 404: notFound },
});

r.post("/:id/lot-bidder-map/preview", {
  summary: "Preview attaching bidders to lots",
  description:
    "Computes per-bidder EMD required (from the EMD ranges / consolidated EMD) and wallet EMD available for the selected lots, " +
    "with a per-row `error` for unknown, unverified or client-blocked bidders. Auction must be published or closed, with EMD set; " +
    "selected lots must fall inside an EMD range.",
  params: IdParam,
  body: bidderLotPairsBody,
  responses: {
    200: AuctionLotBidderMapPreview,
    400: businessError("Auction is draft/archived, EMD not set, or lots outside EMD ranges."),
    404: notFound,
  },
});

r.post("/:id/lot-bidder-map/import", {
  summary: "Import lot bidder map from Excel",
  description:
    "Parses and validates a bulk lot-bidder map .xlsx into review rows (bidder match, lot/EMD display-order sync, " +
    "EMD block rules, wallet coverage). Nothing is saved — submit the reviewed rows via `/lot-bidder-map/submit`.",
  params: IdParam,
  body: xlsxUploadBody,
  responses: { 200: AuctionLotBidderMapImport, 400: xlsxUpload400, 404: notFound },
});

r.get("/:id/additional-fields", {
  summary: "Get auction additional fields",
  description: "Auction-level additional field values, selectable auction fields and the lot-level field columns.",
  params: IdParam,
  responses: { 200: AuctionAdditionalFieldsOverview, 404: notFound },
});

r.get("/:id/additional-fields/lots", {
  summary: "List lot additional field values",
  params: IdParam,
  query: additionalFieldsLotsQuerySchema,
  responses: { 200: AuctionAdditionalFieldLots, 404: notFound },
});

r.patch("/:id/additional-fields/auction/:valueId", {
  summary: "Update auction additional field value",
  description:
    "Updates one auction-level value row; may switch it to another active auction-scope field not already used. The value is validated against the field's data type.",
  body: additionalFieldAuctionRowSchema,
  responses: {
    200: OkBody,
    400: businessError("Value row not found, field inactive/used, or invalid value."),
    404: notFound,
  },
});

r.patch("/:id/additional-fields/lots/:lotId", {
  summary: "Update lot additional field values",
  description: "Upserts values for lot-scope fields selected on the auction. Errors are keyed `values.<fieldId>`.",
  body: additionalFieldLotValuesSchema,
  responses: {
    200: OkBody,
    400: businessError("Lot not in auction, field not selected, or invalid value."),
    404: notFound,
  },
});

r.get("/:id/additional-fields/template", {
  summary: "Download additional fields template",
  params: IdParam,
  responses: { 200: xlsxFile("Additional fields import template (.xlsx)."), 404: notFound },
});

r.post("/:id/additional-fields/import", {
  summary: "Import additional field values from Excel",
  description:
    "Sync import keyed by (Lot No., field): matching rows update, new rows are added, and saved values of active fields " +
    "missing from the file are deleted. Every row must validate first; inactive fields are untouched.",
  params: IdParam,
  body: xlsxUploadBody,
  responses: { 200: AuctionAdditionalFieldsImportResult, 400: xlsxUpload400, 404: notFound },
});

r.post("/:id/lot-bidder-map/submit", {
  summary: "Attach bidders to lots",
  description:
    "Attaches each bidder to its lots. Unless `isEmdWithClient`, the server blocks the full EMD for the lots whose EMD is not with the client " +
    "(always a Full block; no status or amount is accepted). With-client lots post no ledger entry. " +
    "Lots the bidder is already attached to take the requested `isEmdWithClient`, and the block is moved to match in the same transaction. " +
    "Rows are processed independently; per-row outcome is in `results`. Auction must be published or closed, with EMD set. " +
    "On a reopened auction, re-submitting a bidder whose EMD was released at the earlier close (already attached to the lots) re-blocks their EMD.",
  params: IdParam,
  body: z.object({
    rows: z
      .array(
        z.object({
          bidderId: z.number().int().positive(),
          lotIds: z.array(z.number().int().positive()).min(1),
          isEmdWithClient: z.boolean(),
        }),
      )
      .min(1),
  }),
  responses: {
    200: AuctionLotBidderMapSubmitResult,
    400: businessError("Auction is draft/archived, or EMD not set."),
    404: notFound,
  },
});

r.post("/:id/lot-bidder-map/remove", {
  summary: "Detach bidders from lots",
  description:
    "Detaches every selected bidder from every selected lot. In the same transaction, a bidder's EMD block is released " +
    "when no lots with EMD not held by the client remain, otherwise lowered to what those remaining lots require. " +
    "Auction must be published or closed.",
  params: IdParam,
  body: bidderLotPairsBody,
  responses: {
    200: AuctionLotBidderMapRemoveResult,
    400: businessError("Auction is draft/archived, or empty selection."),
    404: notFound,
  },
});

r.get("/:id/lot-bidder-summary", {
  summary: "Lot bidder counts",
  params: IdParam,
  responses: { 200: AuctionLotBidderSummary, 404: notFound },
});

r.get("/:id/lot-bidder-map", {
  summary: "List lot bidder map",
  description:
    "Paginated active lots with their mapped bidders; search matches lot number, display order or bidder name. " +
    "`emdReleased` flags bidders released at an earlier close who hold no block after a reopen.",
  params: IdParam,
  query: lotBidderMapListQuerySchema,
  responses: { 200: AuctionLotBidderMapList, 404: notFound },
});

/* EMD ranges ------------------------------------------------------------- */

r.get("/:id/emd-ranges", {
  summary: "List EMD ranges",
  params: IdParam,
  responses: { 200: AuctionEmdRanges, 404: notFound },
});

r.post("/:id/emd-ranges", {
  summary: "Add EMD range",
  description:
    "Adds one display-order range with its EMD amount. Auction must be published or closed; unrestricted even with bidders " +
    "already attached elsewhere (e.g. a new lot added mid-auction needs its own range) — adding never un-covers an existing lot.",
  params: IdParam,
  body: z.object({ lotDisplayOrderFrom: z.number(), lotDisplayOrderTo: z.number(), emd: z.number() }),
  responses: {
    201: { description: "Range added.", schema: OkBody },
    400: businessError("Auction is draft/archived (not yet published)."),
    404: notFound,
  },
});

r.put("/:id/emd-ranges", {
  summary: "Replace EMD ranges",
  description:
    "Replaces all EMD ranges and sets the consolidated EMD in one transaction. Ranges must cover every active lot's " +
    "display order and their EMD sum must reach the consolidated EMD. Auction must be published or closed. Rejected if, " +
    "for any lot with a bidder already attached, the new set would leave it uncovered or change its covering range's EMD " +
    "amount — detach those bidders first. A range nobody is attached under can be freely added, changed, or removed.",
  params: IdParam,
  body: replaceEmdRangesBody,
  responses: {
    200: AuctionEmdRangesReplaced,
    400: businessError(
      "Invalid ranges/totals, auction is draft/archived (not yet published), or the new ranges would uncover or re-price a lot with attached bidders.",
    ),
    404: notFound,
  },
});

r.delete("/:id/emd-ranges/:lotEmdId", {
  summary: "Delete EMD range",
  description:
    "Auction must be published or closed. Rejected if the range covers a lot with bidders already attached " +
    "(detach those bidders first) — deleting a range nobody is attached under is unrestricted.",
  responses: {
    200: OkBody,
    400: businessError(
      "Auction is draft/archived (not yet published), or the range covers a lot with attached bidders.",
    ),
    404: notFound,
  },
});

/* Documents -------------------------------------------------------------- */

r.get("/:id/catalogue/active/download", {
  summary: "Download active catalogue",
  params: IdParam,
  responses: {
    302: { description: "Redirects to a signed download URL for the catalogue." },
    404: { description: "Auction not found, or no catalogue uploaded.", schema: ErrorBody },
  },
});

r.get("/:id/tnc/active/download", {
  summary: "Download active T&C",
  params: IdParam,
  responses: {
    302: { description: "Redirects to a signed download URL for the T&C." },
    404: { description: "Auction not found, or no T&C uploaded.", schema: ErrorBody },
  },
});

r.get("/:id/documents", {
  summary: "List auction documents",
  params: IdParam,
  query: auctionDocumentsListQuerySchema,
  responses: { 200: AuctionDocumentList, 404: notFound },
});

r.post("/:id/documents", {
  summary: "Upload auction document",
  description:
    "Uploads a catalogue / T&C / other document (pdf or docx) to R2, replacing the active document of that type. " +
    "Allowed while the auction content is editable; reverts a published (pre-live) auction to draft.",
  params: IdParam,
  body: auctionDocumentUploadBody,
  responses: {
    201: { description: "Uploaded document.", schema: AuctionDocumentUploaded },
    400: businessError("File missing, empty or too large, unknown document type, or auction not editable."),
    404: notFound,
  },
});

/* Settlement ------------------------------------------------------------- */

r.get("/:id/approval-lots", {
  summary: "List lots for approval",
  description: "Active lots with winner, winning amount and approval state.",
  params: IdParam,
  responses: { 200: AuctionApprovalLots, 404: notFound },
});

r.get("/:id/no-bid-lots", {
  summary: "List no-bid lots",
  description: "Active lots without bids and their no-bid extension status.",
  params: IdParam,
  responses: { 200: AuctionNoBidLots, 404: notFound },
});

r.post("/:id/stop-no-bid-extension", {
  summary: "Stop no-bid extension for all lots",
  description: "Turns off no-bid extension on every active lot without bids. Auction must be published and live.",
  params: IdParam,
  responses: { 200: OkBody, 400: businessError("Auction not published or not live."), 404: notFound },
});

r.post("/:id/stop-no-bid-extension-lots", {
  summary: "Stop no-bid extension for lots",
  description: "Turns off no-bid extension on the given lots (only those without bids). Auction must be published and live.",
  params: IdParam,
  body: lotIdsBody,
  responses: { 200: OkBody, 400: businessError("Auction not published or not live."), 404: notFound },
});

r.post("/:id/approve-lots", {
  summary: "Approve lots",
  description:
    "Approves the given lots (or `all`) of a closed auction. Lots need a winning amount and an unlocked decision. " +
    "Regenerates the winners' lot confirmation PDFs.",
  params: IdParam,
  body: lotSelectionBody,
  responses: { 200: OkBody, 400: businessError("Auction not closed, or lots cannot be approved."), 404: notFound },
});

r.post("/:id/reject-lots", {
  summary: "Reject lots",
  description:
    "Rejects the given lots (or `all`) of a closed auction, releases the winners' EMD blocks for those lots and regenerates their lot confirmation PDFs.",
  params: IdParam,
  body: lotSelectionBody,
  responses: { 200: OkBody, 400: businessError("Auction not closed."), 404: notFound },
});

r.post("/:id/save-approvals", {
  summary: "Save lot approvals",
  description:
    "Saves per-lot approval (`true` / `false` / `null` = pending) and remarks for a closed auction. " +
    "Rejections release EMD blocks; changed lots regenerate the winners' lot confirmation PDFs.",
  params: IdParam,
  body: z.object({
    entries: z
      .array(
        z.object({
          lotId: z.number().int().positive(),
          isApproved: z.boolean().nullable().optional(),
          remark: z.string().max(200).nullable().optional(),
        }),
      )
      .min(1),
  }),
  responses: { 200: OkBody, 400: businessError("Auction not closed, or lots cannot be approved."), 404: notFound },
});

r.post("/:id/notify-winners", {
  summary: "Email lot confirmations to winners",
  description: "Emails the lot confirmation PDF to the winning bidders of the selected approved lots of a closed auction.",
  params: IdParam,
  body: lotIdsBody,
  responses: {
    200: AuctionNotifyWinnersResult,
    400: businessError("Auction not closed, or no lots selected."),
    404: notFound,
  },
});

/* Catalogue notification ------------------------------------------------- */

r.get("/:id/catalogue-notification/preview", {
  summary: "Preview catalogue notification",
  description: "Email context and eligible bidders for a catalogue notification. Auction must be published or closed.",
  params: IdParam,
  responses: {
    200: AuctionCatalogueNotificationPreview,
    400: businessError("Auction not published."),
    404: notFound,
  },
});

r.get("/:id/catalogue-notification/history", {
  summary: "List catalogue notification history",
  params: IdParam,
  responses: { 200: AuctionCatalogueNotificationHistory, 404: notFound },
});

r.post("/:id/catalogue-notification/send", {
  summary: "Send catalogue notification",
  description:
    "Queues a new/revised catalogue email to the selected eligible bidders (all eligible when `bidderIds` is omitted or " +
    "empty), deduplicated by email, and records it in the history. Requires a published auction with an active catalogue.",
  params: IdParam,
  body: sendCatalogueNotificationSchema,
  responses: {
    200: AuctionCatalogueNotificationSent,
    400: businessError("Auction not published, no catalogue, or no eligible bidders."),
    404: notFound,
  },
});

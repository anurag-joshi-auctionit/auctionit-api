import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import { AUCTION_LOT_IMPORT_MAX_FILE_BYTES } from "../lib/auction-lot-import-constants.js";
import { createAuctionLotWriteSchema } from "../lib/auction-lot-write-schema.js";
import {
  createMemoryUpload,
  createXlsxUpload,
  isXlsxFile,
  runImportSseHandler,
  singleMemoryUpload,
  XLSX_MIME,
} from "../lib/import/index.js";
import {
  createAuctionSchema,
  lotCorrectionSchema,
  reopenLotsCorrectionSchema,
  staggerCorrectionSchema,
  patchAuctionSchema,
  auctionListFilterSchema,
  auctionDocumentsListQuerySchema,
  sendCatalogueNotificationSchema,
} from "../lib/auctions/schemas.js";
import {
  additionalFieldsImportR2Key,
  MAX_AUCTION_DOCUMENT_BYTES,
  MAX_AUCTION_DOCUMENT_MB,
} from "../lib/auction-r2-keys.js";
import { putObject } from "../lib/r2.js";
import { zodValidationErrorBody, fieldValidationErrorBody } from "../lib/validation-error.js";
import { handleEmdError } from "../lib/emd/errors.js";
import {
  broadcastLotDelta,
  broadcastSnapshot,
} from "../live/broadcast.js";
import { entityOptionsQuerySchema, entityOptionIdsQuerySchema } from "../lib/options-query.js";
import { auctionLotImportService } from "../services/auction-lot-import.service.js";
import {
  AuctionLotImportStagingError,
  buildLotImportStagingExportRows,
  getLotImportStagingSession,
} from "../services/auction-lot-import-staging.service.js";
import {
  buildAuctionLotImportTemplateFilename,
  buildAuctionLotImportTemplateXlsx,
} from "../services/auction-lot-import-template.js";
import {
  AuctionLotNotFoundError,
  AuctionNotFoundError,
  AuctionValidationError,
  auctionsService,
} from "../services/auctions.service.js";
import {
  listCatalogueNotificationHistory,
  previewCatalogueNotification,
  sendCatalogueNotification,
} from "../services/catalogue-notification.service.js";
import { auctionAdditionalFieldsService } from "../services/auction-additional-fields.service.js";
import { additionalFieldsImportJobsService } from "../services/additional-fields-import-jobs.service.js";
import {
  pgGetAuctionClientId,
  pgGetAuctionLotWriteContext,
  pgListLotsForExport,
} from "../services/auctions-pg.service.js";
import {
  buildAuctionLotExportFilename,
  buildAuctionLotExportXlsx,
  buildAuctionLotRowsXlsx,
  buildLotImportStagingExportFilename,
} from "../services/auction-lot-export.js";
import {
  buildLotBidderMapImportTemplateFilename,
  buildLotBidderMapImportTemplateXlsx,
} from "../services/lot-bidder-map-import-template.js";
import {
  buildLotBidderMapExportFilename,
  buildLotBidderMapExportXlsx,
} from "../services/lot-bidder-map-export.js";
import {
  AuctionsErrorMessages,
  AuctionsValidationMessages,
} from "@auctionit/messages/auctions";

const router = Router();
router.use(requireAuth, requireAnyPermission(["module.auctions", "auctions.read"]));

const lotImportUpload = createXlsxUpload({
  maxBytes: AUCTION_LOT_IMPORT_MAX_FILE_BYTES,
});

const auctionDocumentUpload = createMemoryUpload({
  maxBytes: MAX_AUCTION_DOCUMENT_BYTES,
});

const auctionDocumentFieldsSchema = z.object({
  documentTypeId: z.coerce.number().int().positive(),
});

const filterEnum = auctionListFilterSchema;

const listQuerySchema = z.object({
  search: z.string().optional(),
  filter: filterEnum.optional(),
  phase: z.enum(["creation", "execution", "settlement"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  year: z.coerce.number().int().min(2000).max(3000).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  dateField: z.enum(["auctionDate", "publishedAt"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
  sortBy: z
    .enum(["auctionDate", "publishedAt", "auctionNumber", "clientName", "status"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

const statsQuerySchema = listQuerySchema.omit({
  filter: true,
  phase: true,
  page: true,
  pageSize: true,
  sortBy: true,
  sortOrder: true,
});

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
    .transform((v) => v === "true" || v === "1"),
});

const lotBidderMapListQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
  sortBy: z.enum(["displayOrder", "lotNumber"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

function parseListOpts(parsed: z.infer<typeof listQuerySchema>) {
  const { year, month, dateFrom, dateTo, dateField, ...rest } = parsed;
  return {
    ...rest,
    month:
      year !== undefined && month !== undefined ? { year, month } : undefined,
    dateFrom,
    dateTo,
    dateField,
  };
}

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleAuctionError(
  err: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (err instanceof AuctionLotNotFoundError) {
    res.status(404).json({ error: AuctionsErrorMessages.LOT_NOT_FOUND });
    return;
  }
  if (err instanceof AuctionNotFoundError) {
    res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
    return;
  }
  if (err instanceof AuctionValidationError) {
    if (err.fieldErrors) {
      res
        .status(400)
        .json(fieldValidationErrorBody(err.fieldErrors, err.message));
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof AuctionLotImportStagingError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (handleEmdError(err, res)) return;
  next(err);
}

router.get("/stats", async (req, res, next) => {
  const parsed = statsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await auctionsService.getStats(parseListOpts(parsed.data));
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/options", async (req, res, next) => {
  const parsed = entityOptionsQuerySchema
    .extend({
      clientId: z.coerce.number().int().positive().optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const options = await auctionsService.listActiveOptions({
      q: parsed.data.q,
      limit: parsed.data.limit,
      ids: parsed.data.ids,
      clientId: parsed.data.clientId,
    });
    res.json({ options });
  } catch (e) {
    next(e);
  }
});

router.get("/options/ids", async (req, res, next) => {
  const parsed = entityOptionIdsQuerySchema
    .extend({
      clientId: z.coerce.number().int().positive().optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await auctionsService.listActiveOptionIds({
      q: parsed.data.q,
      clientId: parsed.data.clientId,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/", async (req, res, next) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await auctionsService.list(parseListOpts(parsed.data));
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/document-types", async (_req, res, next) => {
  try {
    res.json(await auctionsService.listDocumentTypes());
  } catch (e) {
    next(e);
  }
});

// Today's Auctions dashboard (grouped by client on the client). Literal path —
// must stay above "/:id".
router.get("/today", async (_req, res, next) => {
  try {
    res.json(await auctionsService.todaysAuctions());
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createAuctionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    const result = await auctionsService.create(parsed.data, userId);
    res.status(201).json(result);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const auction = await auctionsService.getById(id);
    res.json({ auction });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const parsed = patchAuctionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.update(id, parsed.data, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/publish", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.publish(id, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/unpublish", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.unpublish(id, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/archive", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.archive(id, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/restore", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.restore(id, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const query = lotsListQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json(zodValidationErrorBody(query.error));
    return;
  }
  try {
    res.json(
      await auctionsService.listLots(id, {
        search: query.data.search?.trim() || undefined,
        page: query.data.page,
        pageSize: query.data.pageSize,
        sortBy: query.data.sortBy,
        sortOrder: query.data.sortOrder,
        includeInactive: query.data.includeInactive === true,
      }),
    );
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots/import/template", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const clientId = await pgGetAuctionClientId(id);
    if (!clientId) {
      res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
      return;
    }
    await auctionsService.getById(id);
    const buffer = await buildAuctionLotImportTemplateXlsx(clientId, {
      auctionId: id,
    });
    const filename = buildAuctionLotImportTemplateFilename(id);
    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots/export", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const auction = await auctionsService.getById(id);
    const rows = await pgListLotsForExport(id);
    const buffer = await buildAuctionLotExportXlsx(rows, auction.auctionType);
    const filename = buildAuctionLotExportFilename(id);
    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots/editor-options", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await auctionsService.lotEditorOptions(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post(
  "/:id/lots/import",
  lotImportUpload.single("file"),
  async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: AuctionsValidationMessages.MISSING_IMPORT_FILE,
      });
      return;
    }
    if (!isXlsxFile(file)) {
      res.status(400).json({ error: AuctionsValidationMessages.XLSX_ONLY });
      return;
    }

    try {
      const auction = await auctionsService.getById(id);
      if (!auction.canEditLots) {
        res.status(400).json({
          error: AuctionsValidationMessages.LOTS_EDIT_REQUIRES_DRAFT_OR_PRE_LIVE,
        });
        return;
      }

      const clientId = await pgGetAuctionClientId(id);
      if (!clientId) {
        res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
        return;
      }

      const userId = req.user?.id ?? 1;
      await runImportSseHandler(res, async (writer) => {
        const outcome = await auctionLotImportService.runImportFromBuffer(
          id,
          clientId,
          file.buffer,
          userId,
          auction.auctionDate,
          (progress) => writer.progress(progress),
        );
        if (outcome.kind === "needsReview") {
          writer.needsReview(outcome.review);
          return;
        }
        writer.complete(outcome.result);
      });
    } catch (e) {
      if (!res.headersSent) {
        handleAuctionError(e, res, next);
      }
    }
  },
);

const lotImportStagingConfirmSchema = z.object({
  selections: z
    .array(
      z.object({
        rowNumber: z.number().int().positive(),
        itemId: z.number().int().positive(),
        benchmarkMaterialLocationId: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional(),
      }),
    )
    .min(1),
});

router.get(
  "/:id/lots/import/staging/:stagingId",
  async (req, res, next) => {
    const id = parseId(req.params.id);
    const stagingId = req.params.stagingId?.trim();
    if (!id || !stagingId) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_OR_STAGING_ID });
      return;
    }
    try {
      const auction = await auctionsService.getById(id);
      if (!auction.canEditLots) {
        res.status(400).json({
          error: AuctionsValidationMessages.LOTS_EDIT_REQUIRES_DRAFT_OR_PRE_LIVE,
        });
        return;
      }
      const userId = req.user?.id ?? 1;
      res.json(await getLotImportStagingSession(id, stagingId, userId));
    } catch (e) {
      handleAuctionError(e, res, next);
    }
  },
);

router.post(
  "/:id/lots/import/staging/:stagingId/confirm",
  async (req, res, next) => {
    const id = parseId(req.params.id);
    const stagingId = req.params.stagingId?.trim();
    if (!id || !stagingId) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_OR_STAGING_ID });
      return;
    }
    const body = lotImportStagingConfirmSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(zodValidationErrorBody(body.error));
      return;
    }
    try {
      const auction = await auctionsService.getById(id);
      if (!auction.canEditLots) {
        res.status(400).json({
          error: AuctionsValidationMessages.LOTS_EDIT_REQUIRES_DRAFT_OR_PRE_LIVE,
        });
        return;
      }
      const userId = req.user?.id ?? 1;
      await runImportSseHandler(res, async (writer) => {
        const result = await auctionLotImportService.confirmStagingImport(
          id,
          stagingId,
          userId,
          auction.auctionDate,
          body.data.selections,
          (progress) => writer.progress(progress),
        );
        writer.complete(result);
      });
    } catch (e) {
      if (!res.headersSent) {
        handleAuctionError(e, res, next);
      }
    }
  },
);

const lotImportStagingExportSchema = z.object({
  selections: z.array(
    z.object({
      rowNumber: z.number().int().positive(),
      itemId: z.number().int().positive().nullable().optional(),
      benchmarkMaterialLocationId: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional(),
    }),
  ),
});

router.post(
  "/:id/lots/import/staging/:stagingId/export",
  async (req, res, next) => {
    const id = parseId(req.params.id);
    const stagingId = req.params.stagingId?.trim();
    if (!id || !stagingId) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_OR_STAGING_ID });
      return;
    }
    const body = lotImportStagingExportSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(zodValidationErrorBody(body.error));
      return;
    }
    try {
      const auction = await auctionsService.getById(id);
      if (!auction.canEditLots) {
        res.status(400).json({
          error: AuctionsValidationMessages.LOTS_EDIT_REQUIRES_DRAFT_OR_PRE_LIVE,
        });
        return;
      }
      const userId = req.user?.id ?? 1;
      const rows = await buildLotImportStagingExportRows(
        id,
        stagingId,
        userId,
        body.data.selections,
      );
      const buffer = await buildAuctionLotRowsXlsx(rows, auction.auctionType);
      const filename = buildLotImportStagingExportFilename(id, stagingId);
      res.setHeader("Content-Type", XLSX_MIME);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (e) {
      handleAuctionError(e, res, next);
    }
  },
);

router.post("/:id/lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const ctx = await pgGetAuctionLotWriteContext(id);
  if (!ctx) {
    res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
    return;
  }
  const body = createAuctionLotWriteSchema(
    ctx.auctionType,
    ctx.auctionDate,
    ctx.publishedAt,
    ctx.raStageMaxEndsAt,
  ).safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    const result = await auctionsService.createLot(id, body.data, userId);
    res.status(201).json(result);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/lots/:lotId/withdraw", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  if (!id || !lotId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_OR_LOT_ID });
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.withdrawLot(id, lotId, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.delete("/:id/lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const result = await auctionsService.deleteAllLots(id);
    res.json(result);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots/:lotId", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  if (!id || !lotId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  try {
    res.json(await auctionsService.getLot(id, lotId));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots/:lotId/bids", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  if (!id || !lotId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 10;
  try {
    res.json(
      await auctionsService.lotBidsPaginated(id, lotId, { page, pageSize }),
    );
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots/:lotId/bidders", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  if (!id || !lotId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  try {
    res.json(await auctionsService.lotBidBidders(id, lotId));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.patch("/:id/lots/:lotId", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  if (!id || !lotId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  const ctx = await pgGetAuctionLotWriteContext(id);
  if (!ctx) {
    res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
    return;
  }
  const body = createAuctionLotWriteSchema(
    ctx.auctionType,
    ctx.auctionDate,
    ctx.publishedAt,
    ctx.raStageMaxEndsAt,
  ).safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.patchLot(id, lotId, body.data, userId);
    res.json({ ok: true });
    void broadcastSnapshot(id);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/lots/:lotId/corrections", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  if (!id || !lotId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  const body = lotCorrectionSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.applyLotCorrection(id, lotId, body.data, userId);
    res.json({ ok: true });
    // Bid removals run while the auction is live: push a lot delta so private
    // live:standing clears / reassigns Bid Status (snapshot alone is shared and
    // omits yourStatus, so clients would keep a stale "Bid Accepted").
    if (
      body.data.type === "remove_all_bids" ||
      body.data.type === "remove_winning_bid"
    ) {
      broadcastLotDelta(id, lotId);
    }
    void broadcastSnapshot(id);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots/:lotId/corrections/emd-preview", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  const bidderId = parseId(req.query.bidderId);
  if (!id || !lotId || !bidderId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  try {
    res.json(await auctionsService.previewLotCorrectionEmd(id, lotId, bidderId));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/corrections/stagger", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  const body = staggerCorrectionSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.applyStaggerCorrection(id, body.data, userId);
    res.json({ ok: true });
    void broadcastSnapshot(id);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/corrections/reopen-lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  const body = reopenLotsCorrectionSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.applyReopenLotsCorrection(id, body.data, userId);
    res.json({ ok: true });
    void broadcastSnapshot(id);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/bidder-pool", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await auctionsService.bidderPool(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

// Registered bidders + live participation state, for the dashboard modal.
router.get("/:id/participants", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await auctionsService.auctionParticipants(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.delete("/:id/bidder-pool/:mapId", async (req, res, next) => {
  const id = parseId(req.params.id);
  const mapId = parseId(req.params.mapId);
  if (!id || !mapId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  try {
    await auctionsService.removeBidderPoolEntry(id, mapId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/bidder-pool", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({ bidderIds: z.array(z.number().int().positive()).min(1) })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    const result = await auctionsService.addBidderPoolEntries(
      id,
      body.data.bidderIds,
      userId,
    );
    res.status(201).json(result);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.put("/:id/lots/:lotId/bidders", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  if (!id || !lotId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  const body = z
    .object({ bidderIds: z.array(z.number().int().positive()) })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.setLotBidders(id, lotId, body.data.bidderIds, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/lot-bidder-maps/bulk", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      mappings: z
        .array(
          z.object({
            lotId: z.number().int().positive(),
            bidderIds: z.array(z.number().int().positive()).min(1),
          }),
        )
        .min(1),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.bulkMapBidders(id, body.data.mappings, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lot-bidder-map/template", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    await auctionsService.getById(id);
    const buffer = await buildLotBidderMapImportTemplateXlsx();
    const filename = buildLotBidderMapImportTemplateFilename(id);
    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lot-bidder-map/export", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const rows = await auctionsService.lotBidderMapExportRows(id);
    const buffer = await buildLotBidderMapExportXlsx(rows);
    const filename = buildLotBidderMapExportFilename(id);
    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/lot-bidder-map/preview", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      bidderIds: z.array(z.number().int().positive()).min(1),
      lotIds: z.array(z.number().int().positive()).min(1),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    res.json(
      await auctionsService.lotBidderMapPreview(
        id,
        body.data.bidderIds,
        body.data.lotIds,
      ),
    );
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post(
  "/:id/lot-bidder-map/import",
  lotImportUpload.single("file"),
  async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: AuctionsValidationMessages.MISSING_IMPORT_FILE,
      });
      return;
    }
    if (!isXlsxFile(file)) {
      res.status(400).json({ error: AuctionsValidationMessages.XLSX_ONLY });
      return;
    }
    try {
      res.json(await auctionsService.importLotBidderMap(id, file.buffer));
    } catch (e) {
      handleAuctionError(e, res, next);
    }
  },
);

const additionalFieldValueSchema = z
  .string()
  .max(4000)
  .nullable()
  .optional()
  .transform((v) => v ?? null);

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
    .array(
      z.object({
        fieldId: z.number().int().positive(),
        value: additionalFieldValueSchema,
      }),
    )
    .max(200),
});

router.get("/:id/additional-fields", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await auctionAdditionalFieldsService.getOverview(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/additional-fields/lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const query = additionalFieldsLotsQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json(zodValidationErrorBody(query.error));
    return;
  }
  try {
    res.json(await auctionAdditionalFieldsService.listLots(id, query.data));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.patch("/:id/additional-fields/auction/:valueId", async (req, res, next) => {
  const id = parseId(req.params.id);
  const valueId = parseId(req.params.valueId);
  if (!id || !valueId) {
    res.status(400).json({
      error: !id
        ? AuctionsErrorMessages.INVALID_AUCTION_ID
        : AuctionsErrorMessages.INVALID_ADDITIONAL_FIELD_VALUE_ID,
    });
    return;
  }
  const body = additionalFieldAuctionRowSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionAdditionalFieldsService.updateAuctionRow(id, valueId, body.data, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.patch("/:id/additional-fields/lots/:lotId", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotId = parseId(req.params.lotId);
  if (!id || !lotId) {
    res.status(400).json({
      error: !id
        ? AuctionsErrorMessages.INVALID_AUCTION_ID
        : AuctionsErrorMessages.INVALID_LOT_ID,
    });
    return;
  }
  const body = additionalFieldLotValuesSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionAdditionalFieldsService.updateLotValues(
      id,
      lotId,
      body.data.values,
      userId,
    );
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/additional-fields/template", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const { buffer, filename } = await auctionAdditionalFieldsService.buildTemplate(id);
    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post(
  "/:id/additional-fields/import",
  lotImportUpload.single("file"),
  async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: AuctionsValidationMessages.MISSING_IMPORT_FILE,
      });
      return;
    }
    if (!isXlsxFile(file)) {
      res.status(400).json({ error: AuctionsValidationMessages.XLSX_ONLY });
      return;
    }
    try {
      const userId = req.user?.id ?? 1;
      const fileKey = additionalFieldsImportR2Key(id);
      await putObject({
        key: fileKey,
        body: file.buffer,
        contentType: XLSX_MIME,
      });
      const job = await additionalFieldsImportJobsService.enqueue({
        auctionId: id,
        fileKey,
        userId,
      });
      res.status(202).json({ jobId: job.id });
    } catch (e) {
      handleAuctionError(e, res, next);
    }
  },
);

router.get(
  "/:id/additional-fields/import/:jobId",
  async (req, res, next) => {
    const id = parseId(req.params.id);
    const jobId = parseId(req.params.jobId);
    if (!id || !jobId) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_IMPORT_JOB_ID });
      return;
    }
    try {
      const job = await additionalFieldsImportJobsService.getStatus(jobId);
      if (!job || job.auctionId !== id) {
        res.status(404).json({ error: AuctionsErrorMessages.IMPORT_JOB_NOT_FOUND });
        return;
      }
      res.json(job);
    } catch (e) {
      handleAuctionError(e, res, next);
    }
  },
);

router.post("/:id/lot-bidder-map/submit", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      rows: z
        .array(
          z.object({
            bidderId: z.number().int().positive(),
            lotIds: z.array(z.number().int().positive()).min(1),
            isEmdWithClient: z.boolean(),
          }),
        )
        .min(1),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    res.json(await auctionsService.submitLotBidderMap(id, body.data, userId));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/lot-bidder-map/remove", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      bidderIds: z.array(z.number().int().positive()).min(1),
      lotIds: z.array(z.number().int().positive()).min(1),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    res.json(await auctionsService.removeLotBidderMap(id, body.data, userId));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lot-bidder-summary", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await auctionsService.lotBidderSummary(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lot-bidder-map", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const query = lotBidderMapListQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json(zodValidationErrorBody(query.error));
    return;
  }
  try {
    res.json(
      await auctionsService.lotBidderMap(id, {
        search: query.data.search?.trim() || undefined,
        page: query.data.page,
        pageSize: query.data.pageSize,
        sortBy: query.data.sortBy,
        sortOrder: query.data.sortOrder,
      }),
    );
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/emd-ranges", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await auctionsService.emdRanges(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/emd-ranges", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      lotDisplayOrderFrom: z.number(),
      lotDisplayOrderTo: z.number(),
      emd: z.number(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.addEmdRange(id, body.data, userId);
    res.status(201).json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.put("/:id/emd-ranges", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      consolidatedEmd: z
        .number({
          required_error: AuctionsValidationMessages.CONSOLIDATED_EMD_REQUIRED,
          invalid_type_error:
            AuctionsValidationMessages.CONSOLIDATED_EMD_REQUIRED,
        })
        .positive(AuctionsValidationMessages.CONSOLIDATED_EMD_MUST_BE_POSITIVE),
      ranges: z
        .array(
          z.object({
            displayOrder: z.number().int().positive().nullable().optional(),
            lotDisplayOrderFrom: z.number(),
            lotDisplayOrderTo: z.number(),
            emd: z.number().positive(),
          }),
        )
        .min(1, AuctionsValidationMessages.EMD_AT_LEAST_ONE_RANGE),
    })
    .superRefine((data, ctx) => {
      const rangeEmdSum = data.ranges.reduce((sum, r) => sum + r.emd, 0);
      if (rangeEmdSum + 0.005 < data.consolidatedEmd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ranges"],
          message: AuctionsValidationMessages.EMD_TOTAL_BELOW_CONSOLIDATED,
        });
      }
    })
    .safeParse(req.body);
  if (!body.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          body.error,
          AuctionsValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    const result = await auctionsService.replaceEmdRanges(
      id,
      body.data,
      userId,
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.delete("/:id/emd-ranges/:lotEmdId", async (req, res, next) => {
  const id = parseId(req.params.id);
  const lotEmdId = parseId(req.params.lotEmdId);
  if (!id || !lotEmdId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_ID });
    return;
  }
  try {
    await auctionsService.deleteEmdRange(id, lotEmdId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/catalogue/active/download", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const url = await auctionsService.activeCatalogueDownloadUrl(id);
    if (!url) {
      res.status(404).json({ error: AuctionsErrorMessages.ACTIVE_CATALOGUE_NOT_FOUND });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/tnc/active/download", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const url = await auctionsService.activeTncDownloadUrl(id);
    if (!url) {
      res.status(404).json({ error: AuctionsErrorMessages.ACTIVE_TNC_NOT_FOUND });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/documents", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const parsed = auctionDocumentsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    res.json(await auctionsService.listDocuments(id, parsed.data));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post(
  "/:id/documents",
  singleMemoryUpload(
    auctionDocumentUpload,
    "file",
    AuctionsValidationMessages.DOCUMENT_FILE_TOO_LARGE(MAX_AUCTION_DOCUMENT_MB),
  ),
  async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
      return;
    }

    const fields = auctionDocumentFieldsSchema.safeParse(req.body);
    if (!fields.success) {
      res.status(400).json(zodValidationErrorBody(fields.error));
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: AuctionsValidationMessages.DOCUMENT_FILE_REQUIRED,
      });
      return;
    }
    if (!file.buffer.length) {
      res.status(400).json({
        error: AuctionsValidationMessages.DOCUMENT_FILE_EMPTY,
      });
      return;
    }

    try {
      const userId = req.user?.id ?? 1;
      const result = await auctionsService.uploadDocument(
        id,
        {
          documentTypeId: fields.data.documentTypeId,
          buffer: file.buffer,
          originalFileName: file.originalname,
        },
        userId,
      );
      res.status(201).json(result);
    } catch (e) {
      handleAuctionError(e, res, next);
    }
  },
);

router.get("/:id/approval-lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await auctionsService.approvalLots(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/no-bid-lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await auctionsService.noBidLots(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/stop-no-bid-extension", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.stopNoBidExtensionAll(id, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/stop-no-bid-extension-lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      lotIds: z.array(z.number().int().positive()).min(1),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.stopNoBidExtensionLots(id, body.data.lotIds, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/approve-lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      lotIds: z.array(z.number().int().positive()).optional(),
      all: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.approveLots(id, body.data, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/reject-lots", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      lotIds: z.array(z.number().int().positive()).optional(),
      all: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.rejectLots(id, body.data, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/save-approvals", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      entries: z
        .array(
          z.object({
            lotId: z.number().int().positive(),
            isApproved: z.boolean().nullable().optional(),
            remark: z.string().max(200).nullable().optional(),
          }),
        )
        .min(1),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    await auctionsService.saveLotApprovals(id, body.data.entries, userId);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/notify-winners", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = z
    .object({
      lotIds: z.array(z.number().int().positive()).min(1),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    const result = await auctionsService.notifyWinners(
      id,
      body.data.lotIds,
      userId,
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/catalogue-notification/preview", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json(await previewCatalogueNotification(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/catalogue-notification/history", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    res.json({ rows: await listCatalogueNotificationHistory(id) });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/catalogue-notification/send", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const body = sendCatalogueNotificationSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(zodValidationErrorBody(body.error));
    return;
  }
  try {
    const userId = req.user?.id ?? 1;
    const result = await sendCatalogueNotification(id, body.data, userId);
    res.json({ ok: true, ...result });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

export default router;

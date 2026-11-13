import { AuthzErrorMessages } from "@auctionit/messages/authz";
import {
  LiftingClientsErrorMessages,
  LiftingClientsValidationMessages,
} from "@auctionit/messages/lifting-clients";
import { Router } from "express";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import { LIFTING_CLIENTS_IMPORT_MAX_FILE_BYTES } from "../lib/lifting-clients-import-constants.js";
import {
  createXlsxUpload,
  isXlsxFile,
  runImportSseHandler,
} from "../lib/import/index.js";
import {
  LiftingClientLogNotFoundError,
  LiftingClientValidationError,
  LiftingLotNotFoundError,
} from "../lib/lifting-lot-id.js";
import {
  liftingClientLogBodySchema,
  liftingClientLogUpdateBodySchema,
  liftingClientsImportScopeBodySchema,
  liftingClientsImportScopeQuerySchema,
  liftingClientsListQuerySchema,
  liftingClientsLogsListQuerySchema,
  parseCommaInts,
} from "../lib/lifting-clients/schemas.js";
import { liftingClientsImportService } from "../services/lifting-clients-import.service.js";
import {
  buildLiftingClientsImportTemplateFilename,
  buildLiftingClientsImportTemplateXlsx,
} from "../services/lifting-clients-import-template.js";
import { liftingClientsService } from "../services/lifting-clients.service.js";

const router = Router();
const V = LiftingClientsValidationMessages;

const importUpload = createXlsxUpload({
  maxBytes: LIFTING_CLIENTS_IMPORT_MAX_FILE_BYTES,
});

function invalidLotIdBody() {
  return fieldValidationErrorBody({ id: [V.INVALID_LOT_ID] }, V.INVALID_LOT_ID);
}

router.get(
  "/filter-options/clients",
  requireAuth,
  requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]),
  async (_req, res) => {
    const clients = await liftingClientsService.listClients();
    res.json({ clients });
  },
);

router.get(
  "/filter-options/auctions",
  requireAuth,
  requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]),
  async (req, res) => {
    const clientIds = parseCommaInts(
      typeof req.query.clientIds === "string" ? req.query.clientIds : undefined,
    );
    const auctions = await liftingClientsService.listAuctions(clientIds);
    res.json({ auctions });
  },
);

router.get("/import/template", requireAuth, requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]), async (req, res) => {
  const parsed = liftingClientsImportScopeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(parsed.error, V.INVALID_SCOPE),
    );
    return;
  }

  const buffer = await buildLiftingClientsImportTemplateXlsx({
    clientIds: parsed.data.clientIds,
    auctionIds: parsed.data.auctionIds,
    dispositionStatus: parsed.data.dispositionStatus,
  });
  const filename = buildLiftingClientsImportTemplateFilename();

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
});

router.post(
  "/import",
  requireAuth,
  requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]),
  importUpload.single("file"),
  async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      await runImportSseHandler(res, async (writer) => {
        writer.error({ message: AuthzErrorMessages.UNAUTHENTICATED });
      });
      return;
    }

    const scopeParsed = liftingClientsImportScopeBodySchema.safeParse(req.body);
    if (!scopeParsed.success) {
      await runImportSseHandler(res, async (writer) => {
        writer.error({
          message: V.INVALID_SCOPE,
          code: "invalid_scope",
        });
      });
      return;
    }

    const file = req.file;
    if (!file) {
      await runImportSseHandler(res, async (writer) => {
        writer.error({
          message: V.MISSING_IMPORT_FILE,
        });
      });
      return;
    }

    if (!isXlsxFile(file)) {
      await runImportSseHandler(res, async (writer) => {
        writer.error({
          message: V.XLSX_ONLY,
        });
      });
      return;
    }

    if (file.size > LIFTING_CLIENTS_IMPORT_MAX_FILE_BYTES) {
      await runImportSseHandler(res, async (writer) => {
        writer.error({
          message: V.FILE_TOO_LARGE(
            Math.round(LIFTING_CLIENTS_IMPORT_MAX_FILE_BYTES / (1024 * 1024)),
          ),
        });
      });
      return;
    }

    const scope = {
      clientIds: scopeParsed.data.clientIds,
      auctionIds: scopeParsed.data.auctionIds,
    };

    await runImportSseHandler(res, async (writer) => {
      try {
        const result = await liftingClientsImportService.runImportFromBuffer(
          file.buffer,
          scope,
          userId,
          (update) => writer.progress(update),
        );
        writer.complete(result);
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : LiftingClientsErrorMessages.IMPORT_UNEXPECTED;
        writer.error({ message });
      }
    });
  },
);

router.get("/", requireAuth, requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]), async (req, res) => {
  const parsed = liftingClientsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error, V.VALIDATION_FAILED));
    return;
  }

  const result = await liftingClientsService.list({
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    clientIds: parsed.data.clientIds,
    auctionIds: parsed.data.auctionIds,
    allRecentAuctions: parsed.data.allRecentAuctions,
    dispositionStatus: parsed.data.dispositionStatus,
    search: parsed.data.search,
    sortBy: parsed.data.sortBy?.length ? parsed.data.sortBy : undefined,
    sortOrder: parsed.data.sortOrder,
  });
  res.json(result);
});

function paramId(req: { params: { id?: string | string[] } }): string | null {
  const raw = req.params.id;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return null;
}

function paramLogId(req: {
  params: { logId?: string | string[] };
}): string | null {
  const raw = req.params.logId;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return null;
}

router.get("/:id", requireAuth, requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]), async (req, res) => {
  const id = paramId(req);
  if (!id) {
    res.status(400).json(invalidLotIdBody());
    return;
  }

  try {
    const lot = await liftingClientsService.getById(id);
    if (!lot) {
      res.status(404).json({
        error: "lot_not_found",
        message: LiftingClientsErrorMessages.LOT_NOT_FOUND,
      });
      return;
    }
    res.json({ lot });
  } catch (err) {
    if (err instanceof LiftingLotNotFoundError) {
      res.status(404).json({
        error: "lot_not_found",
        message: LiftingClientsErrorMessages.LOT_NOT_FOUND,
      });
      return;
    }
    throw err;
  }
});

router.get("/:id/logs", requireAuth, requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]), async (req, res) => {
  const id = paramId(req);
  if (!id) {
    res.status(400).json(invalidLotIdBody());
    return;
  }

  const parsed = liftingClientsLogsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error, V.VALIDATION_FAILED));
    return;
  }

  try {
    const result = await liftingClientsService.listLogs(id, parsed.data);
    res.json(result);
  } catch (err) {
    if (err instanceof LiftingLotNotFoundError) {
      res.status(404).json({
        error: "lot_not_found",
        message: LiftingClientsErrorMessages.LOT_NOT_FOUND,
      });
      return;
    }
    throw err;
  }
});

router.post("/:id/logs", requireAuth, requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]), async (req, res) => {
  const id = paramId(req);
  if (!id) {
    res.status(400).json(invalidLotIdBody());
    return;
  }

  const parsed = liftingClientLogBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error, V.VALIDATION_FAILED));
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: AuthzErrorMessages.UNAUTHENTICATED });
    return;
  }

  try {
    const lot = await liftingClientsService.saveLog(id, parsed.data, userId);
    res.status(201).json({ lot });
  } catch (err) {
    if (err instanceof LiftingLotNotFoundError) {
      res.status(404).json({
        error: "lot_not_found",
        message: LiftingClientsErrorMessages.LOT_NOT_FOUND,
      });
      return;
    }
    if (err instanceof LiftingClientValidationError) {
      res.status(400).json(
        fieldValidationErrorBody(
          { [err.field]: [err.message] },
          V.VALIDATION_FAILED,
        ),
      );
      return;
    }
    throw err;
  }
});

router.patch(
  "/:id/logs/:logId",
  requireAuth,
  requireAnyPermission(["module.lifting", "lifting.clients.read", "lifting.clients.write"]),
  async (req, res) => {
    const id = paramId(req);
    const logId = paramLogId(req);
    if (!id || !logId) {
      res.status(400).json(invalidLotIdBody());
      return;
    }

    const parsed = liftingClientLogUpdateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error, V.VALIDATION_FAILED));
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: AuthzErrorMessages.UNAUTHENTICATED });
      return;
    }

    try {
      const result = await liftingClientsService.updateLog(
        id,
        logId,
        parsed.data,
        userId,
      );
      res.json(result);
    } catch (err) {
      if (err instanceof LiftingLotNotFoundError) {
        res.status(404).json({
          error: "lot_not_found",
          message: LiftingClientsErrorMessages.LOT_NOT_FOUND,
        });
        return;
      }
      if (err instanceof LiftingClientLogNotFoundError) {
        res.status(404).json({
          error: "log_not_found",
          message: LiftingClientsErrorMessages.LOG_NOT_FOUND,
        });
        return;
      }
      if (err instanceof LiftingClientValidationError) {
        res.status(400).json(
          fieldValidationErrorBody(
            { [err.field]: [err.message] },
            V.VALIDATION_FAILED,
          ),
        );
        return;
      }
      throw err;
    }
  },
);

export default router;

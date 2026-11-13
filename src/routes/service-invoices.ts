import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  ServiceInvoicesErrorMessages,
  ServiceInvoicesValidationMessages,
} from "@auctionit/messages/service-invoices";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import { hasPermission } from "../auth/permissions.js";
import {
  createPdfUpload,
  createXlsxUpload,
  isPdfFile,
  isXlsxFile,
} from "../lib/import/index.js";
import {
  SI_ANNEXURE_MAX_FILE_BYTES,
  SI_PDF_MAX_FILE_BYTES,
} from "../lib/service-invoices/annexure-constants.js";
import {
  buildServiceInvoiceAnnexureTemplateFilename,
  buildServiceInvoiceAnnexureTemplateXlsx,
} from "../lib/service-invoices/annexure-template.js";
import {
  accountsServiceInvoiceActionSchema,
  annexureAutoQuerySchema,
  createServiceInvoiceSchema,
  parseServiceInvoiceExportIds,
  patchServiceInvoiceSchema,
  serviceInvoicePaymentLogBodySchema,
  serviceInvoiceStatsQuerySchema,
  serviceInvoicesExportQuerySchema,
  serviceInvoicesListQuerySchema,
} from "../lib/service-invoices/schemas.js";
import { SERVICE_INVOICE_EXPORT_MAX_ROWS } from "../lib/service-invoices/export-constants.js";
import {
  buildServiceInvoicesExportFilename,
  buildServiceInvoicesExportXlsx,
} from "../lib/service-invoices/service-invoice-export-xlsx.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import {
  fetchAutoAnnexureLines,
  parseManualAnnexure,
} from "../services/service-invoice-annexure.service.js";
import {
  ServiceInvoicePaymentLogNotFoundError,
  ServiceInvoicePaymentValidationError,
  serviceInvoicePaymentLogsService,
} from "../services/service-invoice-payment-logs.service.js";
import {
  buildServiceInvoicePaymentImportTemplateFilename,
  buildServiceInvoicePaymentImportTemplateXlsx,
  runServiceInvoicePaymentImportFromBuffer,
} from "../services/service-invoice-payment-import.service.js";
import {
  ServiceInvoiceAccountsTransitionError,
  ServiceInvoiceAnnexureError,
  ServiceInvoiceClientNotFoundError,
  ServiceInvoiceForbiddenError,
  ServiceInvoiceLockedError,
  ServiceInvoiceNotFoundError,
  ServiceInvoicePlantNotFoundError,
  ServiceInvoiceValidationError,
  serviceInvoicesService,
} from "../services/service-invoices.service.js";
import { SI_PAYMENT_IMPORT_MAX_FILE_BYTES } from "../lib/service-invoices/payment-import-constants.js";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.service-invoices", "service-invoices.read", "module.accounts-service-invoices"]));

const annexureUpload = createXlsxUpload({
  maxBytes: SI_ANNEXURE_MAX_FILE_BYTES,
});

const paymentImportUpload = createXlsxUpload({
  maxBytes: SI_PAYMENT_IMPORT_MAX_FILE_BYTES,
});

const pdfUpload = createPdfUpload({
  maxBytes: SI_PDF_MAX_FILE_BYTES,
});

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function assertAdminEditor(req: Request): void {
  if (!req.user || !hasPermission(req.user, "service-invoices.admin-edit")) {
    throw new ServiceInvoiceForbiddenError();
  }
}

function assertAccountsEditor(req: Request): void {
  if (!req.user || !hasPermission(req.user, "service-invoices.accounts-edit")) {
    throw new ServiceInvoiceForbiddenError();
  }
}

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ServiceInvoiceNotFoundError) {
    res.status(404).json({ error: ServiceInvoicesErrorMessages.NOT_FOUND });
    return true;
  }
  if (e instanceof ServiceInvoiceForbiddenError) {
    res.status(403).json({ error: ServiceInvoicesErrorMessages.FORBIDDEN });
    return true;
  }
  if (e instanceof ServiceInvoiceLockedError) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.LOCKED });
    return true;
  }
  if (e instanceof ServiceInvoiceAccountsTransitionError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  if (e instanceof ServiceInvoiceValidationError) {
    res
      .status(400)
      .json(
        e.fieldErrors
          ? fieldValidationErrorBody(e.fieldErrors, e.message)
          : { error: e.message },
      );
    return true;
  }
  if (e instanceof ServiceInvoiceAnnexureError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  if (e instanceof ServiceInvoiceClientNotFoundError) {
    res.status(400).json(
      fieldValidationErrorBody(
        { clientId: [ServiceInvoicesErrorMessages.CLIENT_NOT_FOUND] },
        ServiceInvoicesErrorMessages.CLIENT_NOT_FOUND,
      ),
    );
    return true;
  }
  if (e instanceof ServiceInvoicePlantNotFoundError) {
    res.status(400).json(
      fieldValidationErrorBody(
        {
          plantLocationId: [
            ServiceInvoicesValidationMessages.PLANT_NOT_FOR_CLIENT,
          ],
        },
        ServiceInvoicesErrorMessages.PLANT_NOT_FOUND,
      ),
    );
    return true;
  }
  if (e instanceof ServiceInvoicePaymentLogNotFoundError) {
    res.status(404).json({
      error: ServiceInvoicesErrorMessages.PAYMENT_LOG_NOT_FOUND,
    });
    return true;
  }
  if (e instanceof ServiceInvoicePaymentValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/", async (req, res, next) => {
  const parsed = serviceInvoicesListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await serviceInvoicesService.list(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/stats", async (req, res, next) => {
  const parsed = serviceInvoiceStatsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const stats = await serviceInvoicesService.stats(parsed.data.clientId);
    res.json(stats);
  } catch (e) {
    next(e);
  }
});

router.get("/outstanding-stats", async (req, res, next) => {
  const parsed = serviceInvoiceStatsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const stats = await serviceInvoicesService.outstandingStats(
      parsed.data.clientId,
    );
    res.json(stats);
  } catch (e) {
    next(e);
  }
});

router.get("/export", async (req, res, next) => {
  const parsed = serviceInvoicesExportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const { ids: idsRaw, ...filters } = parsed.data;
    const ids = parseServiceInvoiceExportIds(
      idsRaw,
      SERVICE_INVOICE_EXPORT_MAX_ROWS,
    );
    const rows = await serviceInvoicesService.listAllForExport({
      ...filters,
      ids,
    });
    const buffer = await buildServiceInvoicesExportXlsx(rows);
    const filename = buildServiceInvoicesExportFilename();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (e) {
    next(e);
  }
});

const bulkSendEmailSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
});

router.post("/bulk-send-email", async (req, res, next) => {
  const parsed = bulkSendEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    assertAccountsEditor(req);
    const result = await serviceInvoicesService.bulkSendEmail(
      parsed.data.ids,
      req.user?.id,
    );
    res.status(202).json(result);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.post("/:id/send-email", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.NOT_FOUND });
    return;
  }
  try {
    assertAccountsEditor(req);
    const result = await serviceInvoicesService.sendEmail(id, req.user?.id);
    if (!result.ok) {
      const status =
        result.error === ServiceInvoicesErrorMessages.NOT_FOUND ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    res.status(202).json(result);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.get("/payment-logs/import/template", async (req, res, next) => {
  try {
    assertAccountsEditor(req);
    const buffer = await buildServiceInvoicePaymentImportTemplateXlsx();
    const filename = buildServiceInvoicePaymentImportTemplateFilename();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.post(
  "/payment-logs/import",
  paymentImportUpload.single("file"),
  async (req, res, next) => {
    try {
      assertAccountsEditor(req);
      const file = req.file;
      if (!file) {
        res.status(400).json({
          error: ServiceInvoicesValidationMessages.PAYMENT_IMPORT_MISSING_FILE,
        });
        return;
      }
      if (!isXlsxFile(file)) {
        res.status(400).json({
          error: ServiceInvoicesValidationMessages.PAYMENT_IMPORT_XLSX_ONLY,
        });
        return;
      }
      if (file.size > SI_PAYMENT_IMPORT_MAX_FILE_BYTES) {
        res.status(400).json({
          error: ServiceInvoicesValidationMessages.PAYMENT_IMPORT_FILE_TOO_LARGE(
            Math.round(SI_PAYMENT_IMPORT_MAX_FILE_BYTES / (1024 * 1024)),
          ),
        });
        return;
      }

      const result = await runServiceInvoicePaymentImportFromBuffer(
        file.buffer,
        req.user?.id,
      );
      res.json(result);
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.get("/annexure/auto", async (req, res, next) => {
  const parsed = annexureAutoQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  const { fromDate, toDate } = parsed.data;
  if (new Date(toDate) < new Date(fromDate)) {
    res.status(400).json(
      fieldValidationErrorBody(
        { toDate: [ServiceInvoicesValidationMessages.DATE_RANGE_INVALID] },
        ServiceInvoicesValidationMessages.DATE_RANGE_INVALID,
      ),
    );
    return;
  }
  try {
    const result = await fetchAutoAnnexureLines(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/annexure/template", async (_req, res, next) => {
  try {
    const buffer = await buildServiceInvoiceAnnexureTemplateXlsx();
    const filename = buildServiceInvoiceAnnexureTemplateFilename();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (e) {
    next(e);
  }
});

/** Parse/validate only — R2 write happens on invoice create/patch. */
async function handleAnnexureParse(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    assertAdminEditor(req);
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: ServiceInvoicesValidationMessages.ANNEXURE_FILE_REQUIRED,
      });
      return;
    }
    if (!isXlsxFile(file)) {
      res.status(400).json({
        error: ServiceInvoicesValidationMessages.ANNEXURE_FILE_INVALID,
      });
      return;
    }
    const parsed = await parseManualAnnexure(file.buffer);
    res.json({
      ...parsed,
      filename: file.originalname,
    });
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
}

router.post(
  "/annexure/parse",
  annexureUpload.single("file"),
  handleAnnexureParse,
);

/** @deprecated Alias of POST /annexure/parse (parse only, no R2). */
router.post(
  "/annexure/upload",
  annexureUpload.single("file"),
  handleAnnexureParse,
);

router.get("/:id/annexure/download", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  try {
    const result = await serviceInvoicesService.getAnnexureDownloadUrl(id);
    res.json(result);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.get("/:id/annexure/pdf", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  try {
    const result = await serviceInvoicesService.getAnnexurePdfDownloadUrl(
      id,
      req.user?.id,
    );
    res.json(result);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.get("/:id/annexure", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  try {
    const result = await serviceInvoicesService.getAnnexurePreview(id);
    res.json(result);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

async function handlePdfUpload(
  kind: "annexure" | "invoice",
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  try {
    assertAccountsEditor(req);
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: ServiceInvoicesValidationMessages.PDF_FILE_REQUIRED,
      });
      return;
    }
    if (!isPdfFile(file)) {
      res.status(400).json({
        error: ServiceInvoicesValidationMessages.PDF_FILE_INVALID,
      });
      return;
    }
    const updated =
      kind === "annexure"
        ? await serviceInvoicesService.uploadAnnexurePdf(
            id,
            file,
            req.user?.id,
          )
        : await serviceInvoicesService.uploadInvoicePdf(
            id,
            file,
            req.user?.id,
          );
    res.json(updated);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
}

router.post(
  "/:id/files/annexure-pdf",
  pdfUpload.single("file"),
  (req, res, next) => handlePdfUpload("annexure", req, res, next),
);

router.post(
  "/:id/files/invoice-pdf",
  pdfUpload.single("file"),
  (req, res, next) => handlePdfUpload("invoice", req, res, next),
);

router.patch("/:id/accounts", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  const parsed = accountsServiceInvoiceActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ServiceInvoicesValidationMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    assertAccountsEditor(req);
    const updated = await serviceInvoicesService.accountsUpdate(
      id,
      parsed.data,
      req.user?.id,
    );
    res.json(updated);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.get("/:id/payment-logs", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  try {
    const items = await serviceInvoicePaymentLogsService.list(id);
    res.json({ items });
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.post("/:id/payment-logs", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  const parsed = serviceInvoicePaymentLogBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    assertAccountsEditor(req);
    const result = await serviceInvoicePaymentLogsService.create(
      id,
      parsed.data,
      req.user?.id,
    );
    res.status(201).json(result);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.patch("/:id/payment-logs/:logId", async (req, res, next) => {
  const id = parseId(req.params.id);
  const logId = parseId(req.params.logId);
  if (id === null || logId === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  const parsed = serviceInvoicePaymentLogBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    assertAccountsEditor(req);
    const result = await serviceInvoicePaymentLogsService.update(
      id,
      logId,
      parsed.data,
      req.user?.id,
    );
    res.json(result);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  try {
    const row = await serviceInvoicesService.get(id);
    if (!row) {
      res.status(404).json({ error: ServiceInvoicesErrorMessages.NOT_FOUND });
      return;
    }
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createServiceInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    assertAdminEditor(req);
    const created = await serviceInvoicesService.create(
      parsed.data,
      req.user?.id,
    );
    res.status(201).json(created);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ServiceInvoicesErrorMessages.INVALID_ID });
    return;
  }
  const parsed = patchServiceInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    assertAdminEditor(req);
    const updated = await serviceInvoicesService.update(
      id,
      parsed.data,
      req.user?.id,
    );
    res.json(updated);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

export default router;

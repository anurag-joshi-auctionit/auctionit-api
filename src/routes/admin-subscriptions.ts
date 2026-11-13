import { Router, type Request } from "express";
import { z } from "zod";
import {
  SubscriptionsErrorMessages,
  SubscriptionsValidationMessages,
} from "@auctionit/messages/subscriptions";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import { hasPermission } from "../auth/permissions.js";
import { createPdfUpload, createXlsxUpload, isPdfFile, isXlsxFile } from "../lib/import/index.js";
import {
  accountsSubscriptionInvoiceActionSchema,
  adminSubscriptionInvoiceStatusSchema,
  createSubscriptionBodySchema,
  parseSubscriptionExportIds,
  sendSubscriptionPaymentLinkBodySchema,
  subscriptionBiddersListQuerySchema,
  subscriptionInvoiceUploadFieldsSchema,
  subscriptionStatsQuerySchema,
  subscriptionsExportQuerySchema,
  subscriptionsListQuerySchema,
  updateSubscriptionBodySchema,
} from "../lib/subscriptions/schemas.js";
import { SUBSCRIPTION_EXPORT_MAX_ROWS } from "../lib/subscriptions/export-constants.js";
import {
  SUB_INVOICE_IMPORT_MAX_PDFS,
  SUB_INVOICE_IMPORT_MAX_PDF_BYTES,
  SUB_INVOICE_IMPORT_MAX_XLSX_BYTES,
} from "../lib/subscriptions/invoice-import-constants.js";
import { SUBSCRIPTION_PDF_MAX_FILE_BYTES } from "../lib/subscriptions/invoice-r2-keys.js";
import {
  buildSubscriptionsExportFilename,
  buildSubscriptionsExportXlsx,
} from "../lib/subscriptions/subscription-export-xlsx.js";
import { zodValidationErrorBody, fieldValidationErrorBody } from "../lib/validation-error.js";
import {
  SubscriptionLockedError,
  SubscriptionNotFoundError,
  SubscriptionTypeNotFoundError,
  SubscriptionValidationError,
  subscriptionsService,
} from "../services/subscriptions.service.js";
import {
  InstamojoDisabledError,
  SubscriptionPaymentError,
  subscriptionPaymentsService,
} from "../services/subscription-payments.service.js";
import {
  buildSubscriptionInvoiceImportTemplateFilename,
  buildSubscriptionInvoiceImportTemplateXlsx,
  runSubscriptionInvoiceImportFromBuffers,
} from "../services/subscription-invoice-import.service.js";

const router = Router();
router.use(
  requireAuth,
  requireAnyPermission([
    "module.subscriptions",
    "subscriptions.read",
    "module.accounts-subscriptions",
  ]),
);

const pdfUpload = createPdfUpload({
  maxBytes: SUBSCRIPTION_PDF_MAX_FILE_BYTES,
});

const invoiceImportUpload = createXlsxUpload({
  maxBytes: Math.max(
    SUB_INVOICE_IMPORT_MAX_XLSX_BYTES,
    SUB_INVOICE_IMPORT_MAX_PDF_BYTES,
  ),
});

function assertAccountsEditor(req: Request): boolean {
  if (!req.user || !hasPermission(req.user, "subscriptions.accounts-edit")) {
    return false;
  }
  return true;
}

function assertAdminEditor(req: Request): boolean {
  if (!req.user || !hasPermission(req.user, "module.subscriptions")) {
    return false;
  }
  return true;
}

router.get("/", async (req, res, next) => {
  const parsed = subscriptionsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    res.json(await subscriptionsService.list(parsed.data));
  } catch (e) {
    next(e);
  }
});

router.get("/export", async (req, res, next) => {
  const parsed = subscriptionsExportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const { ids: idsRaw, ...filters } = parsed.data;
    const ids = parseSubscriptionExportIds(
      idsRaw,
      SUBSCRIPTION_EXPORT_MAX_ROWS,
    );
    const rows = await subscriptionsService.listAllForExport({
      ...filters,
      ids,
    });
    const buffer = await buildSubscriptionsExportXlsx(rows);
    const filename = buildSubscriptionsExportFilename();
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

router.get("/import/template", async (req, res, next) => {
  if (!assertAccountsEditor(req)) {
    res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
    return;
  }
  try {
    const buffer = await buildSubscriptionInvoiceImportTemplateXlsx();
    const filename = buildSubscriptionInvoiceImportTemplateFilename();
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

router.post(
  "/import",
  invoiceImportUpload.fields([
    { name: "file", maxCount: 1 },
    { name: "pdfs", maxCount: SUB_INVOICE_IMPORT_MAX_PDFS },
  ]),
  async (req, res, next) => {
    if (!assertAccountsEditor(req)) {
      res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
      return;
    }

    const files = req.files as
      | { [fieldname: string]: Express.Multer.File[] }
      | undefined;
    const xlsxFile = files?.file?.[0];
    const pdfFiles = files?.pdfs ?? [];

    if (!xlsxFile) {
      res.status(400).json({
        error: SubscriptionsValidationMessages.INVOICE_IMPORT_MISSING_FILE,
      });
      return;
    }
    if (!isXlsxFile(xlsxFile)) {
      res.status(400).json({
        error: SubscriptionsValidationMessages.INVOICE_IMPORT_XLSX_ONLY,
      });
      return;
    }
    if (xlsxFile.size > SUB_INVOICE_IMPORT_MAX_XLSX_BYTES) {
      res.status(400).json({
        error: SubscriptionsValidationMessages.INVOICE_IMPORT_FILE_TOO_LARGE(
          Math.round(SUB_INVOICE_IMPORT_MAX_XLSX_BYTES / (1024 * 1024)),
        ),
      });
      return;
    }

    if (pdfFiles.length === 0) {
      res.status(400).json({
        error: SubscriptionsValidationMessages.INVOICE_IMPORT_PDFS_REQUIRED,
      });
      return;
    }

    for (const pdf of pdfFiles) {
      if (!isPdfFile(pdf)) {
        res.status(400).json({
          error: SubscriptionsValidationMessages.INVOICE_IMPORT_PDF_INVALID,
        });
        return;
      }
      if (pdf.size > SUB_INVOICE_IMPORT_MAX_PDF_BYTES) {
        res.status(400).json({
          error: SubscriptionsValidationMessages.INVOICE_IMPORT_PDF_TOO_LARGE(
            Math.round(SUB_INVOICE_IMPORT_MAX_PDF_BYTES / (1024 * 1024)),
          ),
        });
        return;
      }
    }

    const userId = req.user?.id;
    if (userId == null) {
      res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
      return;
    }

    try {
      const result = await runSubscriptionInvoiceImportFromBuffers(
        xlsxFile.buffer,
        pdfFiles.map((f) => ({
          originalname: f.originalname,
          buffer: f.buffer,
          size: f.size,
          mimetype: f.mimetype,
        })),
        userId,
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

const bulkSendEmailSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
});

router.post("/bulk-send-email", async (req, res, next) => {
  if (!assertAccountsEditor(req)) {
    res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
    return;
  }
  const parsed = bulkSendEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await subscriptionsService.bulkSendEmail(
      parsed.data.ids,
      req.user?.id,
    );
    res.status(202).json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/send-email", async (req, res, next) => {
  if (!assertAccountsEditor(req)) {
    res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
    return;
  }
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
    return;
  }
  try {
    const result = await subscriptionsService.sendEmail(id, req.user?.id);
    if (!result.ok) {
      const status =
        result.error === SubscriptionsErrorMessages.NOT_FOUND ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    res.status(202).json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/bidders", async (req, res, next) => {
  const parsed = subscriptionBiddersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    res.json(await subscriptionsService.listBidders(parsed.data));
  } catch (e) {
    next(e);
  }
});

router.post("/bidders/:bidderId/send-payment-link", async (req, res, next) => {
  if (!assertAdminEditor(req)) {
    res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
    return;
  }
  const bidderId = parseId(req.params.bidderId);
  if (bidderId === null) {
    res.status(400).json({ error: SubscriptionsErrorMessages.BIDDER_NOT_FOUND });
    return;
  }
  const parsed = sendSubscriptionPaymentLinkBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await subscriptionPaymentsService.sendPaymentLinkEmail({
      bidderId,
      subscriptionTypeId: parsed.data.subscriptionTypeId,
      adminUserId: req.user!.id,
    });
    res.status(202).json(result);
  } catch (e) {
    if (e instanceof InstamojoDisabledError) {
      res.status(503).json({ error: SubscriptionsErrorMessages.PAYMENTS_DISABLED });
      return;
    }
    if (e instanceof SubscriptionPaymentError) {
      const status =
        e.code === "PLAN_NOT_FOUND" || e.code === "BIDDER_NOT_FOUND"
          ? 404
          : e.code === "SEND_FAILED"
            ? 500
            : 400;
      res.status(status).json({ error: e.message });
      return;
    }
    next(e);
  }
});

router.get("/stats", async (req, res, next) => {
  const parsed = subscriptionStatsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    res.json(await subscriptionsService.stats(parsed.data));
  } catch (e) {
    next(e);
  }
});

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Plan-driven autofill (amount + validity period). Not bidder-specific.
router.get("/quote", async (req, res, next) => {
  const typeId = parseId(req.query.typeId);
  if (typeId === null) {
    res
      .status(400)
      .json({ error: SubscriptionsErrorMessages.INVALID_SUBSCRIPTION_TYPE_ID });
    return;
  }
  const fromDate =
    typeof req.query.fromDate === "string" ? req.query.fromDate : undefined;
  try {
    res.json(await subscriptionsService.quote(typeId, fromDate));
  } catch (e) {
    if (e instanceof SubscriptionTypeNotFoundError) {
      res
        .status(404)
        .json({ error: SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NOT_FOUND });
      return;
    }
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  if (!assertAdminEditor(req)) {
    res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
    return;
  }
  const parsed = createSubscriptionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          SubscriptionsValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }
  try {
    const result = await subscriptionsService.record({
      ...parsed.data,
      userId: req.user!.id,
    });
    res.status(201).json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof SubscriptionTypeNotFoundError) {
      res
        .status(404)
        .json({ error: SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NOT_FOUND });
      return;
    }
    if (e instanceof SubscriptionValidationError) {
      res
        .status(400)
        .json(
          e.fieldErrors
            ? fieldValidationErrorBody(e.fieldErrors, e.message)
            : { error: e.message },
        );
      return;
    }
    next(e);
  }
});

router.post(
  "/:id/files/invoice-pdf",
  pdfUpload.single("file"),
  async (req, res, next) => {
    if (!assertAccountsEditor(req)) {
      res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
      return;
    }

    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
      return;
    }

    const fields = subscriptionInvoiceUploadFieldsSchema.safeParse({
      invoiceNumber: req.body?.invoiceNumber,
      invoiceDate: req.body?.invoiceDate,
    });
    if (!fields.success) {
      res
        .status(400)
        .json(
          zodValidationErrorBody(
            fields.error,
            SubscriptionsValidationMessages.VALIDATION_FAILED,
          ),
        );
      return;
    }

    const file = req.file;
    if (!file) {
      res
        .status(400)
        .json({ error: SubscriptionsErrorMessages.PDF_FILE_REQUIRED });
      return;
    }
    if (!isPdfFile(file)) {
      res
        .status(400)
        .json({ error: SubscriptionsValidationMessages.PDF_FILE_INVALID });
      return;
    }

    try {
      const updated = await subscriptionsService.uploadInvoicePdf(
        id,
        { buffer: file.buffer },
        fields.data,
        req.user!.id,
      );
      res.json(updated);
    } catch (e) {
      if (e instanceof SubscriptionNotFoundError) {
        res.status(404).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
        return;
      }
      if (e instanceof SubscriptionValidationError) {
        res
          .status(400)
          .json(
            e.fieldErrors
              ? fieldValidationErrorBody(e.fieldErrors, e.message)
              : { error: e.message },
          );
        return;
      }
      next(e);
    }
  },
);

router.patch("/:id", async (req, res, next) => {
  if (!assertAdminEditor(req)) {
    res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
    return;
  }

  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
    return;
  }

  const parsed = updateSubscriptionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          SubscriptionsValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }

  try {
    const updated = await subscriptionsService.update(id, {
      ...parsed.data,
      userId: req.user!.id,
    });
    res.json(updated);
  } catch (e) {
    if (e instanceof SubscriptionNotFoundError) {
      res.status(404).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
      return;
    }
    if (e instanceof SubscriptionLockedError) {
      res.status(400).json({ error: e.message });
      return;
    }
    if (e instanceof SubscriptionTypeNotFoundError) {
      res
        .status(404)
        .json({ error: SubscriptionsErrorMessages.SUBSCRIPTION_TYPE_NOT_FOUND });
      return;
    }
    if (e instanceof SubscriptionValidationError) {
      res
        .status(400)
        .json(
          e.fieldErrors
            ? fieldValidationErrorBody(e.fieldErrors, e.message)
            : { error: e.message },
        );
      return;
    }
    next(e);
  }
});

router.patch("/:id/accounts", async (req, res, next) => {
  if (!assertAccountsEditor(req)) {
    res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
    return;
  }

  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
    return;
  }

  const parsed = accountsSubscriptionInvoiceActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          SubscriptionsValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }

  try {
    const updated = await subscriptionsService.accountsUpdateInvoiceStatus(
      id,
      parsed.data.status,
      req.user!.id,
    );
    res.json(updated);
  } catch (e) {
    if (e instanceof SubscriptionNotFoundError) {
      res.status(404).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
      return;
    }
    if (e instanceof SubscriptionValidationError) {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

router.patch("/:id/invoice-status", async (req, res, next) => {
  if (!assertAdminEditor(req)) {
    res.status(403).json({ error: SubscriptionsErrorMessages.FORBIDDEN });
    return;
  }

  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
    return;
  }

  const parsed = adminSubscriptionInvoiceStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          SubscriptionsValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }

  try {
    const updated = await subscriptionsService.adminUpdateInvoiceStatus(
      id,
      parsed.data.status,
      req.user!.id,
    );
    res.json(updated);
  } catch (e) {
    if (e instanceof SubscriptionNotFoundError) {
      res.status(404).json({ error: SubscriptionsErrorMessages.NOT_FOUND });
      return;
    }
    if (e instanceof SubscriptionValidationError) {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

export default router;

import { Router } from "express";
import { z } from "zod";
import {
  BiddersErrorMessages,
  BiddersSuccessMessages,
  BiddersValidationMessages,
} from "@auctionit/messages/bidders";
import {
  requireAuth,
  requirePermission,
  requirePortalRole,
} from "../auth/middleware.js";
import { bidderBankAccountBodySchema } from "../lib/bidders/schemas.js";
import {
  createMemoryUpload,
  singleMemoryUpload,
} from "../lib/import/index.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import {
  BankAccountLogAlreadyPendingError,
  BankAccountLogNotFoundError,
  BankAccountLogNotPendingError,
  ChequeFileInvalidError,
  ChequeFileTooLargeError,
  bidderBankAccountLogsService,
} from "../services/bidder-bank-account-logs.service.js";
import { BidderNotFoundError } from "../services/bidders.service.js";

const router = Router();
router.use(requireAuth);

const MAX_CHEQUE_BYTES = 10 * 1024 * 1024;
const chequeUpload = createMemoryUpload({ maxBytes: MAX_CHEQUE_BYTES });

const rejectBodySchema = z.object({
  remark: z
    .string()
    .trim()
    .max(500, BiddersValidationMessages.REVIEW_REMARK_MAX)
    .optional()
    .nullable(),
});

const listQuerySchema = z.object({
  decision: z.enum(["pending", "accepted", "rejected"]).optional().default("pending"),
  search: z.string().trim().optional(),
  bidderId: z.coerce.number().int().positive().optional(),
  dateField: z.enum(["requestedAt", "reviewedAt"]).optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
});

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function bidderIdOf(req: import("express").Request): number | null {
  return req.user?.bidderId ?? null;
}

// ---- Portal (bidder) ----

router.get(
  "/me",
  requirePortalRole("bidder"),
  async (req, res, next) => {
    try {
      const bidderId = bidderIdOf(req);
      if (!bidderId) {
        res.status(403).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
        return;
      }
      const summary =
        await bidderBankAccountLogsService.getPortalSummary(bidderId);
      res.json(summary);
    } catch (err) {
      if (err instanceof BidderNotFoundError) {
        res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
        return;
      }
      next(err);
    }
  },
);

router.get(
  "/me/logs",
  requirePortalRole("bidder"),
  async (req, res, next) => {
    try {
      const bidderId = bidderIdOf(req);
      if (!bidderId) {
        res.status(403).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
        return;
      }
      const items = await bidderBankAccountLogsService.listForBidder(bidderId);
      res.json({ items });
    } catch (err) {
      if (err instanceof BidderNotFoundError) {
        res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
        return;
      }
      next(err);
    }
  },
);

router.post(
  "/logs",
  requirePortalRole("bidder"),
  singleMemoryUpload(
    chequeUpload,
    "cheque",
    BiddersErrorMessages.CHEQUE_FILE_TOO_LARGE,
  ),
  async (req, res, next) => {
    try {
      const bidderId = bidderIdOf(req);
      const userId = req.user?.id;
      if (!bidderId || userId == null) {
        res.status(403).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
        return;
      }

      const parsed = bidderBankAccountBodySchema
        .omit({ chequeBase64: true })
        .safeParse(req.body);
      const file = req.file;

      if (!parsed.success) {
        const body = zodValidationErrorBody(
          parsed.error,
          BiddersValidationMessages.VALIDATION_FAILED,
        );
        // Merge cheque into body fieldErrors so all required errors show together.
        if (!file?.buffer?.length) {
          body.fieldErrors.cheque = [
            BiddersValidationMessages.BANK_CHEQUE_REQUIRED,
          ];
        }
        res.status(400).json(body);
        return;
      }

      if (!file?.buffer?.length) {
        res.status(400).json(
          fieldValidationErrorBody(
            { cheque: [BiddersValidationMessages.BANK_CHEQUE_REQUIRED] },
            BiddersValidationMessages.BANK_CHEQUE_REQUIRED,
          ),
        );
        return;
      }

      const request = await bidderBankAccountLogsService.submit(
        bidderId,
        {
          bankAccount: parsed.data.bankAccount,
          bankName: parsed.data.bankName,
          bankIfsc: parsed.data.bankIfsc,
          cheque: {
            buffer: file.buffer,
            originalFilename: file.originalname || "cheque.jpg",
          },
        },
        userId,
      );

      res.status(201).json({
        message: BiddersSuccessMessages.BANK_UPDATE_SUBMITTED,
        request,
      });
    } catch (err) {
      if (err instanceof BankAccountLogAlreadyPendingError) {
        res
          .status(409)
          .json({ error: BiddersErrorMessages.BANK_UPDATE_ALREADY_PENDING });
        return;
      }
      if (err instanceof ChequeFileInvalidError) {
        res.status(400).json(
          fieldValidationErrorBody(
            { cheque: [BiddersErrorMessages.INVALID_CHEQUE_FILE] },
            BiddersErrorMessages.INVALID_CHEQUE_FILE,
          ),
        );
        return;
      }
      if (err instanceof ChequeFileTooLargeError) {
        res.status(400).json(
          fieldValidationErrorBody(
            { cheque: [BiddersErrorMessages.CHEQUE_FILE_TOO_LARGE] },
            BiddersErrorMessages.CHEQUE_FILE_TOO_LARGE,
          ),
        );
        return;
      }
      if (err instanceof BidderNotFoundError) {
        res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
        return;
      }
      next(err);
    }
  },
);

// ---- Admin ----

router.get(
  "/logs",
  requirePermission("bidder.bank.verify"),
  async (req, res, next) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          error: BiddersValidationMessages.VALIDATION_FAILED,
          issues: parsed.error.flatten(),
        });
        return;
      }
      const [list, counts] = await Promise.all([
        bidderBankAccountLogsService.listForAdmin(parsed.data),
        bidderBankAccountLogsService.countsForAdmin(),
      ]);
      res.json({
        items: list.items,
        total: list.total,
        page: list.page,
        pageSize: list.pageSize,
        counts,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/logs/:id/accept",
  requirePermission("bidder.bank.verify"),
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const userId = req.user?.id;
      if (id === null || userId == null) {
        res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
        return;
      }
      const request = await bidderBankAccountLogsService.accept(id, userId);
      res.json({
        message: BiddersSuccessMessages.BANK_UPDATE_ACCEPTED,
        request,
      });
    } catch (err) {
      if (err instanceof BankAccountLogNotFoundError) {
        res.status(404).json({
          error: BiddersErrorMessages.BANK_UPDATE_NOT_FOUND,
        });
        return;
      }
      if (err instanceof BankAccountLogNotPendingError) {
        res.status(409).json({
          error: BiddersErrorMessages.BANK_UPDATE_NOT_PENDING,
        });
        return;
      }
      next(err);
    }
  },
);

router.post(
  "/logs/:id/reject",
  requirePermission("bidder.bank.verify"),
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const userId = req.user?.id;
      if (id === null || userId == null) {
        res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
        return;
      }
      const parsed = rejectBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: BiddersValidationMessages.VALIDATION_FAILED,
          issues: parsed.error.flatten(),
        });
        return;
      }
      const request = await bidderBankAccountLogsService.reject(
        id,
        userId,
        parsed.data.remark,
      );
      res.json({
        message: BiddersSuccessMessages.BANK_UPDATE_REJECTED,
        request,
      });
    } catch (err) {
      if (err instanceof BankAccountLogNotFoundError) {
        res.status(404).json({
          error: BiddersErrorMessages.BANK_UPDATE_NOT_FOUND,
        });
        return;
      }
      if (err instanceof BankAccountLogNotPendingError) {
        res.status(409).json({
          error: BiddersErrorMessages.BANK_UPDATE_NOT_PENDING,
        });
        return;
      }
      next(err);
    }
  },
);

export default router;

import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { BiddersErrorMessages, BiddersValidationMessages } from "@auctionit/messages/bidders";
import {
  SubscriptionsErrorMessages,
  SubscriptionsValidationMessages,
} from "@auctionit/messages/subscriptions";
import { UsersErrorMessages } from "@auctionit/messages/users";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import {
  bidderInfoSchema,
  bidderStatusSchema,
  biddersListQuerySchema,
  blockBidderBodySchema,
  blockBidderCreateBodySchema,
  blockedBiddersListQuerySchema,
  bidderBlocksListQuerySchema,
  bidderDocumentsListQuerySchema,
  bidderExemptionsListQuerySchema,
  createBidderSchema,
  exemptBidderBodySchema,
  exemptBidderCreateBodySchema,
  exemptedBiddersListQuerySchema,
  bidderBankAccountBodySchema,
  bidderDocumentUploadFieldsSchema,
  bidderSubscriptionBodySchema,
} from "../lib/bidders/schemas.js";
import {
  createEntityUserSchema,
  entityUsersListQuerySchema,
  updateEntityUserSchema,
} from "../lib/users/schemas.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import { entityOptionsQuerySchema, entityOptionIdsQuerySchema } from "../lib/options-query.js";
import { bidderUsersService, UserError } from "../services/users.service.js";
import {
  subscriptionsService,
  SubscriptionTypeNotFoundError,
  SubscriptionValidationError,
} from "../services/subscriptions.service.js";
import { paymentTypesMasterService } from "../services/masters/payment-types.service.js";
import {
  bidderBankAccountsService,
  BidderBankAccountAlreadyVerifiedError,
  BidderBankAccountNotFoundError,
} from "../services/bidder-bank-accounts.service.js";
import {
  BidderDocumentFileInvalidError,
  BidderDocumentTypeNotFoundError,
  listActiveBidderDocumentTypes,
  listBidderDocumentAllowedExtensions,
  listBidderDocuments,
  listBidderDocumentHistory,
  MAX_BIDDER_DOCUMENT_BYTES,
  uploadBidderDocument,
} from "../services/bidder-documents.service.js";
import {
  BidderAlreadyBlockedError,
  BidderAlreadyExemptedError,
  BidderLocationNotFoundError,
  BidderNotBlockedForClientError,
  BidderNotExemptedError,
  BidderNotFoundError,
  biddersService,
  ClientNotFoundError,
} from "../services/bidders.service.js";
import {
  createMemoryUpload,
  singleMemoryUpload,
} from "../lib/import/index.js";

const router = Router();

const bidderDocumentUpload = createMemoryUpload({
  maxBytes: MAX_BIDDER_DOCUMENT_BYTES,
});

const BIDDER_READERS = ["module.bidders", "bidders.read"];

/** Bidder pickers are also used by refund reviewers (e.g. the Accounts role) to filter EMD refunds. */
const BIDDER_OPTION_READERS = [
  ...BIDDER_READERS,
  "emd.refunds.read",
  "emd.refunds.review",
  "emd.refunds.verify",
  "emd.refunds.pay",
];

router.get(
  "/options",
  requireAuth,
  requireAnyPermission(BIDDER_OPTION_READERS),
  async (req, res, next) => {
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
      const options = await biddersService.listActiveBidderOptions({
        q: parsed.data.q,
        limit: parsed.data.limit,
        ids: parsed.data.ids,
        clientId: parsed.data.clientId,
      });
      res.json({ options });
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/options/ids",
  requireAuth,
  requireAnyPermission(BIDDER_OPTION_READERS),
  async (req, res, next) => {
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
      const result = await biddersService.listActiveBidderOptionIds({
        q: parsed.data.q,
        clientId: parsed.data.clientId,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

router.use(requireAuth, requireAnyPermission(BIDDER_READERS));

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleBidderError(err: unknown, res: Response): boolean {
  if (err instanceof BidderNotFoundError) {
    res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
    return true;
  }
  if (err instanceof BidderLocationNotFoundError) {
    res.status(400).json(
      fieldValidationErrorBody(
        { locationId: [BiddersErrorMessages.LOCATION_NOT_FOUND] },
        BiddersErrorMessages.LOCATION_NOT_FOUND,
      ),
    );
    return true;
  }
  if (err instanceof ClientNotFoundError) {
    res.status(400).json(
      fieldValidationErrorBody(
        { clientId: [BiddersErrorMessages.CLIENT_NOT_FOUND] },
        BiddersErrorMessages.CLIENT_NOT_FOUND,
      ),
    );
    return true;
  }
  if (err instanceof BidderAlreadyBlockedError) {
    res.status(409).json(
      fieldValidationErrorBody(
        { clientId: [err.message] },
        err.message,
      ),
    );
    return true;
  }
  if (err instanceof BidderNotBlockedForClientError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof BidderAlreadyExemptedError) {
    res.status(409).json(
      fieldValidationErrorBody(
        { clientId: [err.message] },
        err.message,
      ),
    );
    return true;
  }
  if (err instanceof BidderNotExemptedError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof UserError && err.code === "LOGIN_TAKEN") {
    res.status(409).json(
      fieldValidationErrorBody({ userLoginName: [err.message] }, err.message),
    );
    return true;
  }
  return false;
}

function handleUserError(
  err: unknown,
  res: Response,
  next: NextFunction,
  entityNotFoundMessage: string,
): void {
  if (err instanceof UserError) {
    switch (err.code) {
      case "ENTITY_NOT_FOUND":
        res.status(404).json({ error: entityNotFoundMessage });
        return;
      case "USER_NOT_FOUND":
        res.status(404).json({ error: UsersErrorMessages.USER_NOT_FOUND });
        return;
      case "LOGIN_TAKEN":
        res
          .status(409)
          .json(
            fieldValidationErrorBody(
              { userLoginName: [err.message] },
              err.message,
            ),
          );
        return;
      case "BIDDER_USER_EXISTS":
        res.status(409).json({ error: err.message });
        return;
      case "OTP_MISSING_EMAIL":
      case "OTP_DELIVERY_FAILED":
        res.status(400).json({ error: err.message, code: err.code });
        return;
      default:
        break;
    }
  }
  next(err);
}

function notMigrated(_req: import("express").Request, res: Response) {
  res.status(501).json({ error: BiddersErrorMessages.NOT_MIGRATED });
}

router.get("/", async (req, res, next) => {
  const parsed = biddersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await biddersService.list(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createBidderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await biddersService.create(parsed.data, req.user!.id);
    res.status(201).json(result);
  } catch (e) {
    if (handleBidderError(e, res)) return;
    handleUserError(e, res, next, BiddersErrorMessages.BIDDER_NOT_FOUND);
  }
});

router.get("/stats", async (_req, res, next) => {
  try {
    const counts = await biddersService.getCounts();
    res.json(counts);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/approve", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  try {
    await biddersService.approve(bidderId, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.post("/:id/reject", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  try {
    await biddersService.reject(bidderId, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.get("/payment-types", async (_req, res, next) => {
  try {
    const rows = await paymentTypesMasterService.list(true);
    res.json({
      paymentTypes: rows.map((r) => ({
        paymentTypeId: r.id,
        name: r.name,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.get("/blocked", async (req, res, next) => {
  const parsed = blockedBiddersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await biddersService.listGloballyBlocked(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/blocks", async (req, res, next) => {
  const parsed = blockBidderCreateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await biddersService.blockForClient(
      parsed.data.bidderId,
      parsed.data.clientId,
      parsed.data.reason,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.get("/exempted", async (req, res, next) => {
  const parsed = exemptedBiddersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await biddersService.listGloballyExempted(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/exemptions", async (req, res, next) => {
  const parsed = exemptBidderCreateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await biddersService.exemptForClient(
      parsed.data.bidderId,
      parsed.data.clientId,
      parsed.data.reason,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.get("/document-types", async (_req, res, next) => {
  try {
    const documentTypes = await listActiveBidderDocumentTypes();
    res.json({
      documentTypes,
      allowedExtensions: listBidderDocumentAllowedExtensions(),
    });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  try {
    const bidder = await biddersService.get(id);
    if (!bidder) {
      res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
      return;
    }
    res.json({ bidder });
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/info", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = bidderInfoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await biddersService.updateProfile(bidderId, parsed.data, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.patch("/:id/status", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = bidderStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const detached = await biddersService.setStatus(
      bidderId,
      { isActive: parsed.data.isActive, isVerified: parsed.data.isVerified },
      req.user!.id,
    );
    res.json({
      ok: true,
      removedFromUpcomingLots: detached?.removedMapCount ?? 0,
      releasedEmdAuctions: detached?.releasedEmdAuctionCount ?? 0,
    });
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.get("/:id/documents/history", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = bidderDocumentsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await listBidderDocumentHistory(bidderId, parsed.data);
    res.json(result);
  } catch (e) {
    if (e instanceof BidderNotFoundError) {
      res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
      return;
    }
    next(e);
  }
});

router.get("/:id/documents", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = bidderDocumentsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await listBidderDocuments(bidderId, parsed.data);
    res.json(result);
  } catch (e) {
    if (e instanceof BidderNotFoundError) {
      res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
      return;
    }
    next(e);
  }
});

router.put(
  "/:id/documents",
  singleMemoryUpload(
    bidderDocumentUpload,
    "file",
    BiddersValidationMessages.DOCUMENT_FILE_TOO_LARGE,
  ),
  async (req, res, next) => {
    const bidderId = parseId(req.params.id);
    if (bidderId === null) {
      res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
      return;
    }
    const fields = bidderDocumentUploadFieldsSchema.safeParse(req.body);
    if (!fields.success) {
      res.status(400).json(zodValidationErrorBody(fields.error));
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: BiddersValidationMessages.DOCUMENT_FILE_REQUIRED,
      });
      return;
    }
    if (!file.buffer.length) {
      res.status(400).json({
        error: BiddersErrorMessages.INVALID_DOCUMENT_FILE,
      });
      return;
    }

    try {
      const document = await uploadBidderDocument({
        bidderId,
        documentTypeId: fields.data.documentTypeId,
        buffer: file.buffer,
        originalFileName: file.originalname,
        userId: req.user!.id,
      });
      res.json({ document });
    } catch (e) {
      if (e instanceof BidderNotFoundError) {
        res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
        return;
      }
      if (e instanceof BidderDocumentTypeNotFoundError) {
        res
          .status(400)
          .json({ error: BiddersErrorMessages.DOCUMENT_TYPE_NOT_FOUND });
        return;
      }
      if (e instanceof BidderDocumentFileInvalidError) {
        const message =
          e.message === "INVALID_SIZE"
            ? BiddersValidationMessages.DOCUMENT_FILE_TOO_LARGE
            : BiddersValidationMessages.DOCUMENT_FILE_INVALID;
        res.status(400).json({ error: message });
        return;
      }
      const errMessage = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: errMessage || "Upload failed" });
    }
  },
);

router.get("/:id/bank-account", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  try {
    const bankAccount = await bidderBankAccountsService.getByBidderId(bidderId);
    res.json({ bankAccount });
  } catch (e) {
    if (e instanceof BidderNotFoundError) {
      res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
      return;
    }
    next(e);
  }
});

const MAX_CHEQUE_BYTES = 10 * 1024 * 1024;

router.put("/:id/bank-account", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = bidderBankAccountBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  let cheque: { buffer: Buffer } | undefined;
  if (parsed.data.chequeBase64) {
    let buf: Buffer;
    try {
      buf = Buffer.from(parsed.data.chequeBase64, "base64");
    } catch {
      res.status(400).json({ error: BiddersErrorMessages.INVALID_CHEQUE_FILE });
      return;
    }
    if (buf.length === 0 || buf.length > MAX_CHEQUE_BYTES) {
      res.status(400).json({
        error:
          buf.length === 0
            ? BiddersErrorMessages.INVALID_CHEQUE_FILE
            : BiddersErrorMessages.CHEQUE_FILE_TOO_LARGE,
      });
      return;
    }
    cheque = { buffer: buf };
  }

  try {
    const bankAccount = await bidderBankAccountsService.upsert(
      bidderId,
      {
        bankAccount: parsed.data.bankAccount,
        bankName: parsed.data.bankName,
        bankIfsc: parsed.data.bankIfsc,
        cheque,
      },
      req.user!.id,
    );
    res.json({ bankAccount });
  } catch (e) {
    if (e instanceof BidderNotFoundError) {
      res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
      return;
    }
    next(e);
  }
});

router.post("/:id/bank-account/verify", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  try {
    const bankAccount = await bidderBankAccountsService.verify(
      bidderId,
      req.user!.id,
    );
    res.json({ bankAccount });
  } catch (e) {
    if (e instanceof BidderNotFoundError) {
      res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
      return;
    }
    if (e instanceof BidderBankAccountNotFoundError) {
      res.status(404).json({ error: BiddersErrorMessages.BANK_ACCOUNT_NOT_FOUND });
      return;
    }
    if (e instanceof BidderBankAccountAlreadyVerifiedError) {
      res.status(409).json({ error: BiddersErrorMessages.BANK_ACCOUNT_ALREADY_VERIFIED });
      return;
    }
    next(e);
  }
});

router.post("/:id/bank-account/reject", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  try {
    const bankAccount = await bidderBankAccountsService.reject(
      bidderId,
      req.user!.id,
    );
    res.json({ bankAccount });
  } catch (e) {
    if (e instanceof BidderNotFoundError) {
      res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
      return;
    }
    if (e instanceof BidderBankAccountNotFoundError) {
      res.status(404).json({ error: BiddersErrorMessages.BANK_ACCOUNT_NOT_FOUND });
      return;
    }
    if (e instanceof BidderBankAccountAlreadyVerifiedError) {
      res.status(409).json({ error: BiddersErrorMessages.BANK_ACCOUNT_ALREADY_VERIFIED });
      return;
    }
    next(e);
  }
});

router.get("/:id/users", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = entityUsersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await bidderUsersService.listForBidder(
      bidderId,
      parsed.data,
    );
    res.json(result);
  } catch (e) {
    handleUserError(e, res, next, BiddersErrorMessages.BIDDER_NOT_FOUND);
  }
});

router.post("/:id/users", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = createEntityUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await bidderUsersService.createForBidder(
      bidderId,
      parsed.data,
      req.user!.id,
    );
    res.status(201).json(result);
  } catch (e) {
    handleUserError(e, res, next, BiddersErrorMessages.BIDDER_NOT_FOUND);
  }
});

router.patch("/:id/users/:userId", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (bidderId === null || userId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = updateEntityUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await bidderUsersService.updateForBidder(bidderId, userId, parsed.data, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    handleUserError(e, res, next, BiddersErrorMessages.BIDDER_NOT_FOUND);
  }
});

router.post("/:id/users/:userId/reset-password", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (bidderId === null || userId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  try {
    await bidderUsersService.resetPasswordForBidder(
      bidderId,
      userId,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    handleUserError(e, res, next, BiddersErrorMessages.BIDDER_NOT_FOUND);
  }
});

router.get("/:id/blocks", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = bidderBlocksListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await biddersService.listClientBlocksForBidder(
      bidderId,
      parsed.data,
    );
    res.json(result);
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.post("/:id/blocks", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = blockBidderBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await biddersService.blockForClient(
      bidderId,
      parsed.data.clientId,
      parsed.data.reason,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.post("/:id/blocks/:clientId/unblock", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  const clientId = parseId(req.params.clientId);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  if (clientId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  try {
    const result = await biddersService.unblockForClient(
      bidderId,
      clientId,
      req.user!.id,
    );
    res.json(result);
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.get("/:id/exemptions", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = bidderExemptionsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await biddersService.listClientExemptionsForBidder(
      bidderId,
      parsed.data,
    );
    res.json(result);
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.post("/:id/exemptions", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = exemptBidderBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    await biddersService.exemptForClient(
      bidderId,
      parsed.data.clientId,
      parsed.data.reason,
      req.user!.id,
    );
    res.json({ ok: true });
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

router.post("/:id/exemptions/:clientId/revoke", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  const clientId = parseId(req.params.clientId);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  if (clientId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_CLIENT_ID });
    return;
  }
  try {
    const result = await biddersService.revokeExemptionForClient(
      bidderId,
      clientId,
      req.user!.id,
    );
    res.json(result);
  } catch (e) {
    if (handleBidderError(e, res)) return;
    next(e);
  }
});

// ---- Subscription (per bidder) ----

router.get("/:id/subscriptions", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  try {
    res.json(await subscriptionsService.listForBidder(bidderId));
  } catch (e) {
    next(e);
  }
});

// Plan-driven autofill (amount + validity period) for the add-payment form.
router.get("/:id/subscriptions/quote", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
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

router.post("/:id/subscriptions", async (req, res, next) => {
  const bidderId = parseId(req.params.id);
  if (bidderId === null) {
    res.status(400).json({ error: BiddersErrorMessages.INVALID_BIDDER_ID });
    return;
  }
  const parsed = bidderSubscriptionBodySchema.safeParse(req.body);
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
      bidderId,
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

export default router;

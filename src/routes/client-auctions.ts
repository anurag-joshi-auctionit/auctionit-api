import { Router } from "express";
import { z } from "zod";
import {
  AuctionsValidationMessages,
  ClientPortalAuctionMessages,
} from "@auctionit/messages/auctions";
import {
  requireAuth,
  requirePermission,
  requirePortalRole,
} from "../auth/middleware.js";
import { closedDateRangeQuerySchema } from "../lib/closed-auction-date-range.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import { userCanAccessAuction } from "../services/client-scope.js";
import {
  AuctionNotFoundError,
  AuctionValidationError,
  auctionsService,
} from "../services/auctions.service.js";

const router = Router();
router.use(requireAuth);
router.use(requirePortalRole("client"));
router.use(requirePermission("module.portal-client-auctions"));

function parseAuctionId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handleAuctionError(
  err: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (err instanceof AuctionNotFoundError) {
    res.status(404).json({ error: ClientPortalAuctionMessages.CLOSED_NOT_FOUND });
    return;
  }
  if (err instanceof AuctionValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

async function assertClientClosedAuctionAccess(
  userId: number,
  auctionId: number,
  res: import("express").Response,
): Promise<boolean> {
  if (!(await userCanAccessAuction(userId, auctionId))) {
    res
      .status(403)
      .json({ error: ClientPortalAuctionMessages.AUCTION_FORBIDDEN });
    return false;
  }
  return true;
}

const lotIdsBodySchema = z.object({
  lotIds: z.array(z.number().int().positive()).optional(),
  all: z.boolean().optional(),
});

const saveApprovalsBodySchema = z.object({
  entries: z
    .array(
      z.object({
        lotId: z.number().int().positive(),
        isApproved: z.boolean().nullable().optional(),
        remark: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1),
});

const notifyWinnersBodySchema = z.object({
  lotIds: z.array(z.number().int().positive()).min(1),
});

router.get("/today", async (req, res, next) => {
  try {
    res.json(await auctionsService.portalTodaysAuctions(req.user!.id));
  } catch (e) {
    next(e);
  }
});

router.get("/future", async (req, res, next) => {
  try {
    res.json(await auctionsService.portalFutureAuctions(req.user!.id));
  } catch (e) {
    next(e);
  }
});

router.get("/closed", async (req, res, next) => {
  const parsed = closedDateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AuctionsValidationMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  const range =
    parsed.data.from && parsed.data.to
      ? { from: parsed.data.from, to: parsed.data.to }
      : undefined;
  try {
    res.json(await auctionsService.portalClosedAuctions(req.user!.id, range));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/approval-lots", async (req, res, next) => {
  const id = parseAuctionId(req.params.id);
  if (!id) {
    res.status(400).json({ error: ClientPortalAuctionMessages.CLOSED_NOT_FOUND });
    return;
  }
  try {
    if (!(await assertClientClosedAuctionAccess(req.user!.id, id, res))) return;
    const result = await auctionsService.portalApprovalLots(req.user!.id, id);
    if (!result) {
      res.status(404).json({ error: ClientPortalAuctionMessages.CLOSED_NOT_FOUND });
      return;
    }
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/save-approvals", async (req, res, next) => {
  const id = parseAuctionId(req.params.id);
  if (!id) {
    res.status(400).json({ error: ClientPortalAuctionMessages.CLOSED_NOT_FOUND });
    return;
  }
  const body = saveApprovalsBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(
      zodValidationErrorBody(
        body.error,
        AuctionsValidationMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    if (!(await assertClientClosedAuctionAccess(req.user!.id, id, res))) return;
    await auctionsService.saveLotApprovals(id, body.data.entries, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/approve-lots", async (req, res, next) => {
  const id = parseAuctionId(req.params.id);
  if (!id) {
    res.status(400).json({ error: ClientPortalAuctionMessages.CLOSED_NOT_FOUND });
    return;
  }
  const body = lotIdsBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(
      zodValidationErrorBody(
        body.error,
        AuctionsValidationMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    if (!(await assertClientClosedAuctionAccess(req.user!.id, id, res))) return;
    await auctionsService.approveLots(id, body.data, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/reject-lots", async (req, res, next) => {
  const id = parseAuctionId(req.params.id);
  if (!id) {
    res.status(400).json({ error: ClientPortalAuctionMessages.CLOSED_NOT_FOUND });
    return;
  }
  const body = lotIdsBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(
      zodValidationErrorBody(
        body.error,
        AuctionsValidationMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    if (!(await assertClientClosedAuctionAccess(req.user!.id, id, res))) return;
    await auctionsService.rejectLots(id, body.data, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.post("/:id/notify-winners", async (req, res, next) => {
  const id = parseAuctionId(req.params.id);
  if (!id) {
    res.status(400).json({ error: ClientPortalAuctionMessages.CLOSED_NOT_FOUND });
    return;
  }
  const body = notifyWinnersBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json(
      zodValidationErrorBody(
        body.error,
        AuctionsValidationMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    if (!(await assertClientClosedAuctionAccess(req.user!.id, id, res))) return;
    const result = await auctionsService.notifyWinners(
      id,
      body.data.lotIds,
      req.user!.id,
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id", async (req, res, next) => {
  const id = parseAuctionId(req.params.id);
  if (!id) {
    res.status(400).json({ error: ClientPortalAuctionMessages.UPCOMING_NOT_FOUND });
    return;
  }
  try {
    const result = await auctionsService.portalAuctionDetail(req.user!.id, id);
    if (!result) {
      res.status(404).json({ error: ClientPortalAuctionMessages.UPCOMING_NOT_FOUND });
      return;
    }
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/:id/participants", async (req, res, next) => {
  const id = parseAuctionId(req.params.id);
  if (!id) {
    res.status(400).json({ error: ClientPortalAuctionMessages.UPCOMING_NOT_FOUND });
    return;
  }
  try {
    if (!(await userCanAccessAuction(req.user!.id, id))) {
      res.status(403).json({ error: ClientPortalAuctionMessages.AUCTION_FORBIDDEN });
      return;
    }
    res.json(await auctionsService.auctionParticipants(id));
  } catch (e) {
    handleAuctionError(e, res, next);
  }
});

router.get("/:id/lots", async (req, res, next) => {
  const id = parseAuctionId(req.params.id);
  if (!id) {
    res.status(400).json({ error: ClientPortalAuctionMessages.UPCOMING_NOT_FOUND });
    return;
  }
  const closed = req.query.bucket === "closed";
  try {
    const result = closed
      ? await auctionsService.portalClosedLots(req.user!.id, id)
      : await auctionsService.portalUpcomingLots(req.user!.id, id);
    if (!result) {
      res.status(404).json({
        error: closed
          ? ClientPortalAuctionMessages.CLOSED_NOT_FOUND
          : ClientPortalAuctionMessages.UPCOMING_NOT_FOUND,
      });
      return;
    }
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;

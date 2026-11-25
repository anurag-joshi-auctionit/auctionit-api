import { Router, type Response } from "express";
import { requireAnyPermission, requireAuth } from "../auth/middleware.js";
import { AUCTION_RA_STAGE_KEYS, type AuctionRaStageKey } from "../db/schema/question-templates.js";
import {
  invitableBiddersQuerySchema,
  inviteBiddersSchema,
  saveStageSetupSchema,
  saveStagesConfigSchema,
  setStageDecisionSchema,
} from "../lib/auction-ra-stages/schemas.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import { AuctionNotFoundError } from "../services/auctions-errors.js";
import { auctionRaStagesConfigService } from "../services/auction-ra-stages/config.service.js";
import { AuctionRaStageNotFoundError, AuctionRaStageValidationError } from "../services/auction-ra-stages/errors.js";
import { auctionRaStagesInvitationsService } from "../services/auction-ra-stages/invitations.service.js";
import { auctionRaStagesResponsesService } from "../services/auction-ra-stages/responses.service.js";
import { auctionRaStagesSetupService } from "../services/auction-ra-stages/setup.service.js";

const router = Router({ mergeParams: true });

router.use(requireAuth);

function parseAuctionId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseStageKey(value: unknown): AuctionRaStageKey | null {
  if (typeof value !== "string") return null;
  return (AUCTION_RA_STAGE_KEYS as readonly string[]).includes(value)
    ? (value as AuctionRaStageKey)
    : null;
}

function parseBidderId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof AuctionNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof AuctionRaStageNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof AuctionRaStageValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

router.get(
  "/ra-stages/active-auctions",
  requireAnyPermission(["auctions.read"]),
  async (_req, res, next) => {
    try {
      res.json(await auctionRaStagesConfigService.listActiveAuctions());
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/:auctionId/ra-stages",
  requireAnyPermission(["auctions.read", "auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    if (auctionId === null) {
      res.status(400).json({ error: "Invalid auction id." });
      return;
    }
    try {
      res.json(await auctionRaStagesConfigService.getStages(auctionId));
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.put(
  "/:auctionId/ra-stages/config",
  requireAnyPermission(["auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    if (auctionId === null) {
      res.status(400).json({ error: "Invalid auction id." });
      return;
    }
    const parsed = saveStagesConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    const userId = req.user?.id ?? 1;
    try {
      res.json(await auctionRaStagesConfigService.saveConfig(auctionId, parsed.data, userId));
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.put(
  "/:auctionId/ra-stages/:stageKey",
  requireAnyPermission(["auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    const stageKey = parseStageKey(req.params.stageKey);
    if (auctionId === null || stageKey === null) {
      res.status(400).json({ error: "Invalid auction id or stage key." });
      return;
    }
    const parsed = saveStageSetupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    const userId = req.user?.id ?? 1;
    try {
      res.json(
        await auctionRaStagesSetupService.saveStageSetup(auctionId, stageKey, parsed.data, userId),
      );
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.get(
  "/:auctionId/ra-stages/invitable-bidders",
  requireAnyPermission(["auctions.read", "auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    if (auctionId === null) {
      res.status(400).json({ error: "Invalid auction id." });
      return;
    }
    const parsed = invitableBiddersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    try {
      res.json(await auctionRaStagesInvitationsService.listInvitable(auctionId, parsed.data));
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.get(
  "/:auctionId/ra-stages/invite-filter-options",
  requireAnyPermission(["auctions.read", "auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    if (auctionId === null) {
      res.status(400).json({ error: "Invalid auction id." });
      return;
    }
    try {
      res.json(await auctionRaStagesInvitationsService.listInviteFilterOptions(auctionId));
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.get(
  "/:auctionId/ra-stages/invited-bidders",
  requireAnyPermission(["auctions.read", "auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    if (auctionId === null) {
      res.status(400).json({ error: "Invalid auction id." });
      return;
    }
    try {
      res.json(await auctionRaStagesInvitationsService.listInvited(auctionId));
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.post(
  "/:auctionId/ra-stages/invited-bidders",
  requireAnyPermission(["auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    if (auctionId === null) {
      res.status(400).json({ error: "Invalid auction id." });
      return;
    }
    const parsed = inviteBiddersSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    const userId = req.user?.id ?? 1;
    try {
      await auctionRaStagesInvitationsService.invite(auctionId, parsed.data, userId);
      res.status(201).json({ ok: true });
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.delete(
  "/:auctionId/ra-stages/invited-bidders/:bidderId",
  requireAnyPermission(["auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    const bidderId = parseBidderId(req.params.bidderId);
    if (auctionId === null || bidderId === null) {
      res.status(400).json({ error: "Invalid auction id or bidder id." });
      return;
    }
    const userId = req.user?.id ?? 1;
    try {
      await auctionRaStagesInvitationsService.withdraw(auctionId, bidderId, userId);
      res.json({ ok: true });
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.get(
  "/:auctionId/ra-stages/:stageKey/responses",
  requireAnyPermission(["auctions.read", "auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    const stageKey = parseStageKey(req.params.stageKey);
    if (auctionId === null || stageKey === null) {
      res.status(400).json({ error: "Invalid auction id or stage key." });
      return;
    }
    try {
      res.json(await auctionRaStagesResponsesService.listResponses(auctionId, stageKey));
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.get(
  "/:auctionId/ra-stages/:stageKey/responses/:bidderId",
  requireAnyPermission(["auctions.read", "auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    const stageKey = parseStageKey(req.params.stageKey);
    const bidderId = parseBidderId(req.params.bidderId);
    if (auctionId === null || stageKey === null || bidderId === null) {
      res.status(400).json({ error: "Invalid auction id, stage key, or bidder id." });
      return;
    }
    try {
      res.json(
        await auctionRaStagesResponsesService.getResponseDetail(auctionId, stageKey, bidderId),
      );
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

router.post(
  "/:auctionId/ra-stages/:stageKey/responses/:bidderId/decision",
  requireAnyPermission(["auction.ra-stages.write"]),
  async (req, res, next) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    const stageKey = parseStageKey(req.params.stageKey);
    const bidderId = parseBidderId(req.params.bidderId);
    if (auctionId === null || stageKey === null || bidderId === null) {
      res.status(400).json({ error: "Invalid auction id, stage key, or bidder id." });
      return;
    }
    const parsed = setStageDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    const userId = req.user?.id ?? 1;
    try {
      await auctionRaStagesResponsesService.setDecision(
        auctionId,
        stageKey,
        bidderId,
        parsed.data,
        userId,
      );
      res.json({ ok: true });
    } catch (e) {
      if (handleError(e, res)) return;
      next(e);
    }
  },
);

export default router;

import { Router, type Response } from "express";
import multer from "multer";
import { requireAuth, requirePortalRole } from "../auth/middleware.js";
import { AUCTION_RA_STAGE_KEYS, type AuctionRaStageKey } from "../db/schema/question-templates.js";
import { bidderRaStageSubmissionService } from "../services/auction-ra-stages/bidder-submission.service.js";
import { AuctionRaStageValidationError } from "../services/auction-ra-stages/errors.js";

const router = Router();

router.use(requireAuth, requirePortalRole("bidder"));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function bidderIdOf(req: import("express").Request): number | null {
  return req.user?.bidderId ?? null;
}

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

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof AuctionRaStageValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/auctions/:auctionId", async (req, res, next) => {
  const auctionId = parseAuctionId(req.params.auctionId);
  const bidderId = bidderIdOf(req);
  if (auctionId === null || bidderId === null) {
    res.status(400).json({ error: "Invalid auction id." });
    return;
  }
  try {
    res.json(await bidderRaStageSubmissionService.listMyInvitations(auctionId, bidderId));
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.get("/auctions/:auctionId/:stageKey", async (req, res, next) => {
  const auctionId = parseAuctionId(req.params.auctionId);
  const stageKey = parseStageKey(req.params.stageKey);
  const bidderId = bidderIdOf(req);
  if (auctionId === null || stageKey === null || bidderId === null) {
    res.status(400).json({ error: "Invalid auction id or stage key." });
    return;
  }
  try {
    res.json(await bidderRaStageSubmissionService.getMyStage(auctionId, stageKey, bidderId));
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.post("/auctions/:auctionId/:stageKey/submit", upload.any(), async (req, res, next) => {
  const auctionId = parseAuctionId(req.params.auctionId);
  const stageKey = parseStageKey(req.params.stageKey);
  const bidderId = bidderIdOf(req);
  if (auctionId === null || stageKey === null || bidderId === null) {
    res.status(400).json({ error: "Invalid auction id or stage key." });
    return;
  }

  let answers: Record<string, string | string[] | undefined> = {};
  try {
    answers = req.body.answers ? JSON.parse(req.body.answers) : {};
  } catch {
    res.status(400).json({ error: "Invalid answers payload." });
    return;
  }

  const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
  const files = uploadedFiles
    .filter((f) => f.fieldname.startsWith("file_"))
    .map((f) => ({
      questionId: f.fieldname.slice("file_".length),
      filename: f.originalname,
      mimetype: f.mimetype,
      buffer: f.buffer,
    }));

  const userId = req.user?.id ?? bidderId;

  try {
    await bidderRaStageSubmissionService.submit(auctionId, stageKey, bidderId, answers, files, userId);
    res.json({ ok: true });
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

export default router;

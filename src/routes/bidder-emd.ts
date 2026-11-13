import { Router, type Request, type Response } from "express";
import { EmdErrorMessages } from "@auctionit/messages/emd";
import { requireAuth, requirePortalRole } from "../auth/middleware.js";
import { failEmd, parseEmdInput, parseEmdParam } from "../lib/emd/route-helpers.js";
import {
  emdPageQuerySchema,
  emdRefundIdParamSchema,
  emdRefundRaiseSchema,
} from "../lib/emd/schemas.js";
import { emdBlocksService } from "../services/emd-blocks.service.js";
import { emdForfeituresService } from "../services/emd-forfeitures.service.js";
import { emdRefundsService } from "../services/emd-refunds.service.js";
import { emdTransactionsService } from "../services/emd-transactions.service.js";

/** Bidder portal EMD: own balances, passbook, holdings and refund requests. */
const router = Router();
router.use(requireAuth);
router.use(requirePortalRole("bidder"));

function bidderIdOf(req: Request, res: Response): number | null {
  const bidderId = req.user?.bidderId;
  if (!bidderId) {
    res.status(403).json({ error: EmdErrorMessages.NOT_A_BIDDER });
    return null;
  }
  return bidderId;
}

router.get("/summary", async (req, res, next) => {
  const bidderId = bidderIdOf(req, res);
  if (bidderId == null) return;
  try {
    res.json(await emdBlocksService.summary(bidderId));
  } catch (e) {
    failEmd(e, res, next);
  }
});

router.get("/transactions", async (req, res, next) => {
  const bidderId = bidderIdOf(req, res);
  if (bidderId == null) return;
  const q = parseEmdInput(emdPageQuerySchema, req.query, res);
  if (!q) return;
  try {
    res.json(await emdTransactionsService.list({ bidderId, ...q, hideCorrectedBlocks: true }));
  } catch (e) {
    failEmd(e, res, next);
  }
});

router.get("/blocked", async (req, res, next) => {
  const bidderId = bidderIdOf(req, res);
  if (bidderId == null) return;
  const q = parseEmdInput(emdPageQuerySchema, req.query, res);
  if (!q) return;
  try {
    res.json(await emdBlocksService.blocked(bidderId, q));
  } catch (e) {
    failEmd(e, res, next);
  }
});

router.get("/refunds", async (req, res, next) => {
  const bidderId = bidderIdOf(req, res);
  if (bidderId == null) return;
  const q = parseEmdInput(emdPageQuerySchema, req.query, res);
  if (!q) return;
  try {
    res.json(await emdRefundsService.list({ bidderId, ...q }));
  } catch (e) {
    failEmd(e, res, next);
  }
});

router.post("/refunds", async (req, res, next) => {
  const bidderId = bidderIdOf(req, res);
  if (bidderId == null) return;
  const body = parseEmdInput(emdRefundRaiseSchema, req.body, res);
  if (!body) return;
  try {
    res.status(201).json(await emdRefundsService.raise({ bidderId, ...body, userId: req.user!.id }));
  } catch (e) {
    failEmd(e, res, next);
  }
});

router.post("/refunds/:refundId/cancel", async (req, res, next) => {
  const bidderId = bidderIdOf(req, res);
  if (bidderId == null) return;
  const refundId = parseEmdParam(emdRefundIdParamSchema, req.params.refundId, res);
  if (refundId == null) return;
  try {
    await emdRefundsService.cancelByBidder({ refundId, bidderId, userId: req.user!.id });
    res.json({ ok: true });
  } catch (e) {
    failEmd(e, res, next);
  }
});

router.get("/forfeitures", async (req, res, next) => {
  const bidderId = bidderIdOf(req, res);
  if (bidderId == null) return;
  const q = parseEmdInput(emdPageQuerySchema, req.query, res);
  if (!q) return;
  try {
    res.json(await emdForfeituresService.list({ bidderId, view: "forfeited", ...q }));
  } catch (e) {
    failEmd(e, res, next);
  }
});

export default router;

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePortalRole } from "../auth/middleware.js";
import { hasPermission } from "../auth/permissions.js";
import { AuctionsErrorMessages } from "@auctionit/messages/auctions";
import { AuthzErrorMessages } from "@auctionit/messages/authz";
import { BidderDashboardMessages } from "@auctionit/messages/bidder-dashboard";
import { LiveAuctionMessages } from "@auctionit/messages/live";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  isPortalClientRole,
  userCanAccessAuction,
  userCanAccessLot,
} from "../services/client-scope.js";
import {
  broadcastLotDelta,
  broadcastSnapshot,
} from "../live/broadcast.js";
import { resolveAuctionVisibility } from "../live/visibility.js";
import { liveSseHandler } from "../live/sse-stream.js";
import { closeAllSseClients } from "../live/sse-hub.js";
import {
  getLiveTransportConfig,
  liveTransportModeSchema,
  setLiveTransportMode,
} from "../live/transport-config.js";
import {
  liveAuctionService,
  projectLotDetailsForBidder,
} from "../services/live-auction.service.js";
import { liveBidService } from "../services/live-bid.service.js";
import { sealedBidService } from "../services/sealed-bid.service.js";

const router = Router();
router.use(requireAuth);

// Transport policy every live client reads on start-up (and re-reads
// periodically) to decide which push channel to open.
router.get("/transport", (_req, res) => {
  res.json(getLiveTransportConfig());
});

const transportModeBody = z.object({ mode: liveTransportModeSchema });

// Admin kill switch: forces every client onto one transport, or back to auto.
router.put("/transport", async (req, res, next) => {
  if (req.user?.role.isAdmin !== true || req.user?.bidderId != null) {
    res.status(403).json({ error: AuthzErrorMessages.ADMIN_ONLY });
    return;
  }
  const parsed = transportModeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const config = await setLiveTransportMode(parsed.data.mode, req.user.id);
    // Forcing Socket.IO means the SSE fallback is no longer trusted — hang up
    // open streams so those clients reconnect on the mandated transport
    // instead of sitting on a channel the operator just ruled out.
    if (config.mode === "socket") closeAllSseClients("transport_mode_changed");
    res.json(config);
  } catch (e) {
    next(e);
  }
});

// Server→client fallback feed. Mutations stay on the REST endpoints below.
router.get("/stream", (req, res, next) => {
  liveSseHandler(req, res).catch(next);
});

router.get("/auctions", async (req, res, next) => {
  try {
    if (isPortalClientRole(req.user?.role.code)) {
      if (!hasPermission(req.user!, "module.portal-client-auctions")) {
        res.status(403).json({
          error: AuthzErrorMessages.FORBIDDEN,
          code: "permission_denied",
        });
        return;
      }
      res.json(await liveAuctionService.listLive(null, req.user!.id));
      return;
    }
    res.json(await liveAuctionService.listLive(req.user?.bidderId ?? null));
  } catch (e) {
    next(e);
  }
});

router.get("/auctions/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const isClient = isPortalClientRole(req.user?.role.code);
    if (isClient) {
      if (!hasPermission(req.user!, "module.portal-client-auctions")) {
        res.status(403).json({
          error: AuthzErrorMessages.FORBIDDEN,
          code: "permission_denied",
        });
        return;
      }
      if (!(await userCanAccessAuction(req.user!.id, id))) {
        res.status(403).json({ error: LiveAuctionMessages.AUCTION_FORBIDDEN });
        return;
      }
      const snapshot = await liveAuctionService.getSnapshot(id, {
        audience: "client",
      });
      if (!snapshot) {
        res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
        return;
      }
      res.json(snapshot);
      return;
    }
    const isStaffAdmin =
      req.user?.role.isAdmin === true && req.user?.bidderId == null;
    if (!isStaffAdmin) {
      const vis = await resolveAuctionVisibility(id, req.user?.bidderId ?? null);
      if (!vis) {
        res.status(403).json({ error: LiveAuctionMessages.AUCTION_FORBIDDEN });
        return;
      }
      const snapshot = await liveAuctionService.getSnapshot(id, {
        audience: "bidder",
        bidderId: req.user?.bidderId,
        visibility: vis,
      });
      if (!snapshot) {
        res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
        return;
      }
      res.json(snapshot);
      return;
    }
    const snapshot = await liveAuctionService.getSnapshot(id, {
      audience: "admin",
    });
    if (!snapshot) {
      res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
      return;
    }
    res.json(snapshot);
  } catch (e) {
    next(e);
  }
});

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  if (req.user?.bidderId != null) {
    res.status(403).json({ error: LiveAuctionMessages.ADMINS_ONLY });
    return false;
  }
  return true;
}

function parseLotId(
  req: import("express").Request,
  res: import("express").Response,
): number | null {
  const lotId = Number(req.params.lotId);
  if (!Number.isInteger(lotId) || lotId <= 0) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_LOT_ID });
    return null;
  }
  return lotId;
}

async function allowLotDrilldown(
  req: import("express").Request,
  res: import("express").Response,
  lotId: number,
): Promise<boolean> {
  if (isPortalClientRole(req.user?.role.code)) {
    if (!hasPermission(req.user!, "module.portal-client-auctions")) {
      res.status(403).json({
        error: AuthzErrorMessages.FORBIDDEN,
        code: "permission_denied",
      });
      return false;
    }
    if (!(await userCanAccessLot(req.user!.id, lotId))) {
      res.status(403).json({ error: LiveAuctionMessages.LOT_FORBIDDEN });
      return false;
    }
    return true;
  }
  return requireAdmin(req, res);
}

router.get("/lots/:lotId/bids", async (req, res, next) => {
  const lotId = parseLotId(req, res);
  if (lotId == null) return;
  try {
    if (!(await allowLotDrilldown(req, res, lotId))) return;
    res.json(await liveAuctionService.lotBids(lotId));
  } catch (e) {
    next(e);
  }
});

router.get("/lots/:lotId/bidders", async (req, res, next) => {
  const lotId = parseLotId(req, res);
  if (lotId == null) return;
  try {
    if (!(await allowLotDrilldown(req, res, lotId))) return;
    res.json(await liveAuctionService.lotBidders(lotId));
  } catch (e) {
    next(e);
  }
});

router.get("/lots/:lotId/details", async (req, res, next) => {
  const lotId = parseLotId(req, res);
  if (lotId == null) return;
  try {
    if (isPortalClientRole(req.user?.role.code)) {
      if (!hasPermission(req.user!, "module.portal-client-auctions")) {
        res.status(403).json({
          error: AuthzErrorMessages.FORBIDDEN,
          code: "permission_denied",
        });
        return;
      }
      if (!(await userCanAccessLot(req.user!.id, lotId))) {
        res.status(403).json({ error: LiveAuctionMessages.LOT_FORBIDDEN });
        return;
      }
    }
    const found = await liveAuctionService.lotDetails(lotId);
    if (!found) {
      res.status(404).json({ error: AuctionsErrorMessages.LOT_NOT_FOUND });
      return;
    }
    const bidderId = isPortalClientRole(req.user?.role.code)
      ? null
      : (req.user?.bidderId ?? null);
    if (bidderId == null) {
      res.json(found.details);
      return;
    }
    // Bidders: only lots they are mapped to, and never the sealed-phase bounds
    // (same rule as the sealed-bid view and the live snapshot).
    const vis = await resolveAuctionVisibility(found.auctionId, bidderId);
    if (!vis || (vis.lotIds != null && !vis.lotIds.has(lotId))) {
      res.status(403).json({ error: AuthzErrorMessages.FORBIDDEN });
      return;
    }
    res.json(projectLotDetailsForBidder(found.details, found.sealedPhase));
  } catch (e) {
    next(e);
  }
});

const bidSchema = z.object({ amount: z.coerce.number().positive() });

router.post("/auctions/:auctionId/lots/:lotId/bid", requirePortalRole("bidder"), async (req, res, next) => {
  const auctionId = Number(req.params.auctionId);
  const lotId = Number(req.params.lotId);
  if (
    !Number.isInteger(auctionId) ||
    auctionId <= 0 ||
    !Number.isInteger(lotId) ||
    lotId <= 0
  ) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_OR_LOT_ID });
    return;
  }
  const bidderId = req.user?.bidderId;
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const parsed = bidSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await liveBidService.placeBid({
      auctionId,
      lotId,
      bidderId,
      userId: req.user!.id,
      amount: parsed.data.amount,
      ip: req.ip,
    });
    if (!result.accepted) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({
      ok: true,
      amount: result.amount,
      finalAmount: result.finalAmount,
      yourStatus: result.yourStatus,
      rev: result.rev,
      extended: result.extended,
      yourRank: result.yourRank,
      yourBid: result.yourBid,
    });
    // Always push lot delta + private standing. Extension/stagger also need a
    // full snapshot for timer fields — but snapshot alone omits yourStatus, so
    // skipping the delta left the sole winner stuck on Outbid in the bidder UI.
    broadcastLotDelta(auctionId, lotId, result.affectedBidderIds);
    if (result.extended) void broadcastSnapshot(auctionId);
  } catch (e) {
    next(e);
  }
});

// --- Sealed-bid window --------------------------------------------------
// Bidders get only their own latest bid; the leader, rank, start price and bid
// limit stay server-side. No socket push — nothing about other bids is shown.

router.get("/sealed-auctions", async (req, res, next) => {
  try {
    if (isPortalClientRole(req.user?.role.code)) {
      if (!hasPermission(req.user!, "module.portal-client-auctions")) {
        res.status(403).json({
          error: AuthzErrorMessages.FORBIDDEN,
          code: "permission_denied",
        });
        return;
      }
      res.json(await sealedBidService.listOpen({ clientUserId: req.user!.id }));
      return;
    }
    res.json(
      await sealedBidService.listOpen({ bidderId: req.user?.bidderId ?? null }),
    );
  } catch (e) {
    next(e);
  }
});

router.get(
  "/auctions/:auctionId/sealed-bids/me",
  requirePortalRole("bidder"),
  async (req, res, next) => {
    const auctionId = Number(req.params.auctionId);
    if (!Number.isInteger(auctionId) || auctionId <= 0) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
      return;
    }
    const bidderId = req.user?.bidderId;
    if (!bidderId) {
      res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
      return;
    }
    try {
      const vis = await resolveAuctionVisibility(auctionId, bidderId);
      if (!vis) {
        res.status(403).json({ error: LiveAuctionMessages.AUCTION_FORBIDDEN });
        return;
      }
      const view = await sealedBidService.myView(auctionId, bidderId, vis);
      if (!view) {
        res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
        return;
      }
      res.json(view);
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/auctions/:auctionId/lots/:lotId/sealed-bid",
  requirePortalRole("bidder"),
  async (req, res, next) => {
    const auctionId = Number(req.params.auctionId);
    const lotId = Number(req.params.lotId);
    if (
      !Number.isInteger(auctionId) ||
      auctionId <= 0 ||
      !Number.isInteger(lotId) ||
      lotId <= 0
    ) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_OR_LOT_ID });
      return;
    }
    const bidderId = req.user?.bidderId;
    if (!bidderId) {
      res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
      return;
    }
    const parsed = bidSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    try {
      const result = await sealedBidService.placeSealedBid({
        auctionId,
        lotId,
        bidderId,
        userId: req.user!.id,
        amount: parsed.data.amount,
        ip: req.ip,
      });
      if (!result.accepted) {
        res.status(400).json({ error: result.reason });
        return;
      }
      res.json({ ok: true, yourBid: result.yourBid, placedAt: result.placedAt });
    } catch (e) {
      next(e);
    }
  },
);

router.get("/auctions/:auctionId/sealed-bids/summary", async (req, res, next) => {
  const auctionId = Number(req.params.auctionId);
  if (!Number.isInteger(auctionId) || auctionId <= 0) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    if (isPortalClientRole(req.user?.role.code)) {
      if (!hasPermission(req.user!, "module.portal-client-auctions")) {
        res.status(403).json({
          error: AuthzErrorMessages.FORBIDDEN,
          code: "permission_denied",
        });
        return;
      }
      if (!(await userCanAccessAuction(req.user!.id, auctionId))) {
        res.status(403).json({ error: LiveAuctionMessages.AUCTION_FORBIDDEN });
        return;
      }
    } else if (!requireAdmin(req, res)) {
      return;
    }
    res.json(await sealedBidService.summary(auctionId));
  } catch (e) {
    next(e);
  }
});

router.get("/lots/:lotId/sealed-bids", async (req, res, next) => {
  const lotId = parseLotId(req, res);
  if (lotId == null) return;
  try {
    if (!(await allowLotDrilldown(req, res, lotId))) return;
    res.json(await sealedBidService.lotBids(lotId));
  } catch (e) {
    next(e);
  }
});

const proxySchema = z.object({ maxAmount: z.coerce.number().positive() });

router.post(
  "/auctions/:auctionId/lots/:lotId/proxy",
  requirePortalRole("bidder"),
  async (req, res, next) => {
    const auctionId = Number(req.params.auctionId);
    const lotId = Number(req.params.lotId);
    if (
      !Number.isInteger(auctionId) ||
      auctionId <= 0 ||
      !Number.isInteger(lotId) ||
      lotId <= 0
    ) {
      res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_OR_LOT_ID });
      return;
    }
    const bidderId = req.user?.bidderId;
    if (!bidderId) {
      res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
      return;
    }
    const parsed = proxySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    try {
      const result = await liveBidService.setProxyBid({
        auctionId,
        lotId,
        bidderId,
        userId: req.user!.id,
        maxAmount: parsed.data.maxAmount,
        ip: req.ip,
      });
      if (!result.accepted) {
        res.status(400).json({ error: result.reason });
        return;
      }
      res.json({
        ok: true,
        maxAmount: result.maxAmount,
        finalAmount: result.finalAmount,
        yourStatus: result.yourStatus,
        rev: result.rev,
        extended: result.extended,
        yourRank: result.yourRank,
        yourBid: result.yourBid,
      });
      // Same as placeBid: delta+standing always; snapshot only when timers move.
      broadcastLotDelta(auctionId, lotId, result.affectedBidderIds);
      if (result.extended) void broadcastSnapshot(auctionId);
    } catch (e) {
      next(e);
    }
  },
);

router.get("/auctions/:auctionId/my-proxies", async (req, res, next) => {
  const auctionId = Number(req.params.auctionId);
  if (!Number.isInteger(auctionId) || auctionId <= 0) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  const bidderId = req.user?.bidderId;
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  try {
    res.json(await liveBidService.myProxies(auctionId, bidderId));
  } catch (e) {
    next(e);
  }
});

router.get("/my-proxies", async (req, res, next) => {
  const bidderId = req.user?.bidderId;
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  try {
    res.json(await liveBidService.myProxiesAll(bidderId));
  } catch (e) {
    next(e);
  }
});

router.get("/my-participation", async (req, res, next) => {
  const bidderId = req.user?.bidderId;
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  try {
    res.json(await liveBidService.myParticipation(bidderId));
  } catch (e) {
    next(e);
  }
});

router.get("/watchlist", async (req, res, next) => {
  const bidderId = req.user?.bidderId;
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  try {
    res.json(await liveBidService.watchlist(bidderId));
  } catch (e) {
    next(e);
  }
});

router.post("/lots/:lotId/watch", requirePortalRole("bidder"), async (req, res, next) => {
  const lotId = Number(req.params.lotId);
  const bidderId = req.user?.bidderId;
  if (!Number.isInteger(lotId) || lotId <= 0) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_LOT_ID });
    return;
  }
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  try {
    await liveBidService.addToWatchlist(bidderId, lotId);
    res.json({ ok: true, watched: true });
  } catch (e) {
    next(e);
  }
});

router.delete("/lots/:lotId/watch", requirePortalRole("bidder"), async (req, res, next) => {
  const lotId = Number(req.params.lotId);
  const bidderId = req.user?.bidderId;
  if (!Number.isInteger(lotId) || lotId <= 0) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_LOT_ID });
    return;
  }
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  try {
    await liveBidService.removeFromWatchlist(bidderId, lotId);
    res.json({ ok: true, watched: false });
  } catch (e) {
    next(e);
  }
});

export default router;

import { Router } from "express";
import { z } from "zod";
import { BidderDashboardMessages } from "@auctionit/messages/bidder-dashboard";
import {
  requireAuth,
  requirePermission,
  requirePortalRole,
} from "../auth/middleware.js";
import { closedDateRangeQuerySchema } from "../lib/closed-auction-date-range.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import { bidderDashboardService } from "../services/bidder-dashboard.service.js";

const router = Router();
router.use(requireAuth);
router.use(requirePortalRole("bidder"));
router.use(requirePermission("module.portal-bidder-dashboard"));

const rangeSchema = closedDateRangeQuerySchema;

const liftingQuerySchema = rangeSchema.and(
  z.object({
    clientId: z.coerce.number().int().positive().optional(),
    plantLocationId: z.coerce.number().int().positive().optional(),
    itemId: z.coerce.number().int().positive().optional(),
  }),
);

const filtersQuerySchema = rangeSchema.and(
  z.object({
    clientId: z.coerce.number().int().positive().optional(),
  }),
);

function bidderIdOf(req: import("express").Request): number | null {
  return req.user?.bidderId ?? null;
}

function requireDateRange(
  data: { from?: string; to?: string },
  res: import("express").Response,
): boolean {
  if (!data.from || !data.to) {
    res
      .status(400)
      .json({ error: BidderDashboardMessages.DATE_RANGE_REQUIRED });
    return false;
  }
  return true;
}

function requireBidder(
  req: import("express").Request,
  res: import("express").Response,
): number | null {
  const bidderId = bidderIdOf(req);
  if (bidderId == null) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return null;
  }
  return bidderId;
}

router.get("/clients", async (req, res, next) => {
  const bidderId = requireBidder(req, res);
  if (bidderId == null) return;
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        BidderDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await bidderDashboardService.listClients(bidderId, {
        from: parsed.data.from!,
        to: parsed.data.to!,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/lifting/filters", async (req, res, next) => {
  const bidderId = requireBidder(req, res);
  if (bidderId == null) return;
  const parsed = filtersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        BidderDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await bidderDashboardService.getLiftingFilters(
        bidderId,
        { from: parsed.data.from!, to: parsed.data.to! },
        parsed.data.clientId,
      ),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/lifting", async (req, res, next) => {
  const bidderId = requireBidder(req, res);
  if (bidderId == null) return;
  const parsed = liftingQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        BidderDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await bidderDashboardService.getLiftingDetails(
        bidderId,
        { from: parsed.data.from!, to: parsed.data.to! },
        {
          clientId: parsed.data.clientId,
          plantLocationId: parsed.data.plantLocationId,
          itemId: parsed.data.itemId,
        },
      ),
    );
  } catch (e) {
    next(e);
  }
});

export default router;

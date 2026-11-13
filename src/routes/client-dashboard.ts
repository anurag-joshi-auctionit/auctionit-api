import { Router } from "express";
import { z } from "zod";
import { ClientDashboardMessages } from "@auctionit/messages/client-dashboard";
import {
  requireAuth,
  requirePermission,
  requirePortalRole,
} from "../auth/middleware.js";
import { closedDateRangeQuerySchema } from "../lib/closed-auction-date-range.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  ClientDashboardAccessError,
  ClientDashboardNotFoundError,
  clientDashboardService,
} from "../services/client-dashboard.service.js";

const router = Router();
router.use(requireAuth);
router.use(requirePortalRole("client"));
router.use(requirePermission("module.portal-client-dashboard"));

const clientIdQuerySchema = z.object({
  clientId: z.coerce.number().int().positive({
    message: ClientDashboardMessages.CLIENT_REQUIRED,
  }),
});

const rangeClientSchema = closedDateRangeQuerySchema.and(clientIdQuerySchema);

const materialQuerySchema = rangeClientSchema.and(
  z.object({
    plantLocationId: z.coerce.number().int().positive().optional(),
    itemId: z.coerce.number().int().positive().optional(),
  }),
);

const bidderQuerySchema = rangeClientSchema.and(
  z.object({
    auctionId: z.coerce.number().int().positive().optional(),
  }),
);

function handleDashboardError(
  err: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (err instanceof ClientDashboardAccessError) {
    res.status(403).json({ error: err.message });
    return;
  }
  if (err instanceof ClientDashboardNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  next(err);
}

function requireDateRange(
  data: { from?: string; to?: string },
  res: import("express").Response,
): data is { from: string; to: string } {
  if (!data.from || !data.to) {
    res
      .status(400)
      .json({ error: ClientDashboardMessages.DATE_RANGE_REQUIRED });
    return false;
  }
  return true;
}

router.get("/clients", async (req, res, next) => {
  try {
    res.json(await clientDashboardService.listClients(req.user!.id));
  } catch (e) {
    next(e);
  }
});

router.get("/auctions", async (req, res, next) => {
  const parsed = rangeClientSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await clientDashboardService.listAuctions(
        req.user!.id,
        parsed.data.clientId,
        { from: parsed.data.from, to: parsed.data.to },
      ),
    );
  } catch (e) {
    handleDashboardError(e, res, next);
  }
});

router.get("/summary", async (req, res, next) => {
  const parsed = rangeClientSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await clientDashboardService.getSummary(
        req.user!.id,
        parsed.data.clientId,
        { from: parsed.data.from, to: parsed.data.to },
      ),
    );
  } catch (e) {
    handleDashboardError(e, res, next);
  }
});

router.get("/material/filters", async (req, res, next) => {
  const parsed = rangeClientSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await clientDashboardService.getMaterialFilters(
        req.user!.id,
        parsed.data.clientId,
        { from: parsed.data.from, to: parsed.data.to },
      ),
    );
  } catch (e) {
    handleDashboardError(e, res, next);
  }
});

router.get("/material", async (req, res, next) => {
  const parsed = materialQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await clientDashboardService.getMaterialSeries(
        req.user!.id,
        parsed.data.clientId,
        { from: parsed.data.from, to: parsed.data.to },
        {
          plantLocationId: parsed.data.plantLocationId,
          itemId: parsed.data.itemId,
        },
      ),
    );
  } catch (e) {
    handleDashboardError(e, res, next);
  }
});

router.get("/lifting", async (req, res, next) => {
  const parsed = rangeClientSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await clientDashboardService.getLiftingDetails(
        req.user!.id,
        parsed.data.clientId,
        { from: parsed.data.from, to: parsed.data.to },
      ),
    );
  } catch (e) {
    handleDashboardError(e, res, next);
  }
});

router.get("/bidder", async (req, res, next) => {
  const parsed = bidderQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientDashboardMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!requireDateRange(parsed.data, res)) return;
  try {
    res.json(
      await clientDashboardService.getBidderDetails(
        req.user!.id,
        parsed.data.clientId,
        { from: parsed.data.from, to: parsed.data.to },
        parsed.data.auctionId,
      ),
    );
  } catch (e) {
    handleDashboardError(e, res, next);
  }
});

export default router;

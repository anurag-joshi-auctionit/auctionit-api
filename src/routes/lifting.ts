import { AuthzErrorMessages } from "@auctionit/messages/authz";
import {
  LiftingBidderErrorMessages,
  LiftingBidderValidationMessages,
} from "@auctionit/messages/lifting-bidders";
import { Router } from "express";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import {
  liftingBiddersListQuerySchema,
  liftingBiddersStatsQuerySchema,
  liftingEngagementBodySchema,
} from "../lib/lifting-bidders/schemas.js";
import {
  LiftingNotFoundError,
  LiftingValidationError,
  liftingService,
} from "../services/lifting.service.js";

const router = Router();
const V = LiftingBidderValidationMessages;

function listParamsFromQuery(
  data: ReturnType<typeof liftingBiddersListQuerySchema.parse>,
): Parameters<typeof liftingService.list>[0] {
  return {
    page: data.page,
    pageSize: data.pageSize,
    search: data.search?.length ? data.search : undefined,
    sortBy: data.sortBy?.length ? data.sortBy : undefined,
    sortOrder: data.sortOrder,
    clientNames: data.clients,
    bidderName: data.bidderName?.length ? data.bidderName : undefined,
    dispositionStatus: data.dispositionStatus,
    dateField: data.dateField,
    dateFrom: data.dateFrom,
    dateTo: data.dateTo,
  };
}

function invalidLotIdBody() {
  return fieldValidationErrorBody({ id: [V.INVALID_LOT_ID] }, V.INVALID_LOT_ID);
}

router.get("/", requireAuth, requireAnyPermission(["module.lifting", "lifting.bidders.read", "lifting.bidders.write"]), async (req, res) => {
  const parsed = liftingBiddersListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error, V.VALIDATION_FAILED));
    return;
  }
  const result = await liftingService.list(listParamsFromQuery(parsed.data));
  res.json(result);
});

router.get("/stats", requireAuth, requireAnyPermission(["module.lifting", "lifting.bidders.read", "lifting.bidders.write"]), async (req, res) => {
  const parsed = liftingBiddersStatsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error, V.VALIDATION_FAILED));
    return;
  }
  const stats = await liftingService.stats(parsed.data.todayDate);
  res.json(stats);
});

router.get("/filter-options", requireAuth, requireAnyPermission(["module.lifting", "lifting.bidders.read", "lifting.bidders.write"]), async (_req, res) => {
  const options = await liftingService.filterOptions();
  res.json(options);
});

function paramId(req: { params: { id?: string | string[] } }): string | null {
  const raw = req.params.id;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return null;
}

router.get("/:id", requireAuth, requireAnyPermission(["module.lifting", "lifting.bidders.read", "lifting.bidders.write"]), async (req, res) => {
  const id = paramId(req);
  if (!id) {
    res.status(400).json(invalidLotIdBody());
    return;
  }
  if (id === "clients") {
    res.status(404).json({
      error: "not_found",
      message: LiftingBidderErrorMessages.LOT_NOT_FOUND,
    });
    return;
  }
  let lot;
  try {
    lot = await liftingService.getById(id);
  } catch (err) {
    if (err instanceof LiftingNotFoundError) {
      res.status(404).json({
        error: "lot_not_found",
        message: LiftingBidderErrorMessages.LOT_NOT_FOUND,
      });
      return;
    }
    throw err;
  }
  if (!lot) {
    res.status(404).json({
      error: "lot_not_found",
      message: LiftingBidderErrorMessages.LOT_NOT_FOUND,
    });
    return;
  }
  res.json({ lot });
});

router.get("/:id/engagements", requireAuth, requireAnyPermission(["module.lifting", "lifting.bidders.read", "lifting.bidders.write"]), async (req, res) => {
  const id = paramId(req);
  if (!id) {
    res.status(400).json(invalidLotIdBody());
    return;
  }
  try {
    const engagements = await liftingService.listEngagements(id);
    res.json({ engagements });
  } catch (err) {
    if (err instanceof LiftingNotFoundError) {
      res.status(404).json({
        error: "lot_not_found",
        message: LiftingBidderErrorMessages.LOT_NOT_FOUND,
      });
      return;
    }
    throw err;
  }
});

router.post("/:id/engagements", requireAuth, requireAnyPermission(["module.lifting", "lifting.bidders.read", "lifting.bidders.write"]), async (req, res) => {
  const id = paramId(req);
  if (!id) {
    res.status(400).json(invalidLotIdBody());
    return;
  }

  const parsed = liftingEngagementBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(parsed.error, V.VALIDATION_FAILED),
    );
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: AuthzErrorMessages.UNAUTHENTICATED });
    return;
  }

  try {
    const result = await liftingService.logEngagement(
      id,
      parsed.data,
      userId,
    );
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof LiftingNotFoundError) {
      res.status(404).json({
        error: "lot_not_found",
        message: LiftingBidderErrorMessages.LOT_NOT_FOUND,
      });
      return;
    }
    if (err instanceof LiftingValidationError) {
      res.status(400).json(
        fieldValidationErrorBody(
          { [err.field]: [err.message] },
          V.VALIDATION_FAILED,
        ),
      );
      return;
    }
    throw err;
  }
});

export default router;

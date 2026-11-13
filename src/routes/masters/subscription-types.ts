import { SubscriptionsErrorMessages } from "@auctionit/messages/subscriptions";
import { Router, type Response } from "express";
import { requireAuth, requireAnyPermission } from "../../auth/middleware.js";
import {
  createSubscriptionTypeSchema,
  patchSubscriptionTypeSchema,
} from "../../lib/subscription-types/schemas.js";
import { zodValidationErrorBody } from "../../lib/validation-error.js";
import {
  SubscriptionTypeNotFoundError,
  SubscriptionTypeValidationError,
  subscriptionTypesMasterService,
} from "../../services/masters/subscription-types.service.js";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.masters"]));

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof SubscriptionTypeNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof SubscriptionTypeValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/", async (req, res, next) => {
  try {
    const activeOnly = req.query.activeOnly === "true";
    res.json(await subscriptionTypesMasterService.list(activeOnly));
  } catch (e) {
    next(e);
  }
});

router.get("/options", async (_req, res, next) => {
  try {
    res.json(await subscriptionTypesMasterService.list(true));
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createSubscriptionTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await subscriptionTypesMasterService.create(
      parsed.data,
      req.user?.id,
    );
    res.status(201).json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: SubscriptionsErrorMessages.INVALID_SUBSCRIPTION_TYPE_ID });
    return;
  }

  const parsed = patchSubscriptionTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await subscriptionTypesMasterService.update(
      id,
      parsed.data,
      req.user?.id,
    );
    res.json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

export default router;

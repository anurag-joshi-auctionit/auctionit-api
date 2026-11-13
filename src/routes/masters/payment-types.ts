import { MastersErrorMessages } from "@auctionit/messages/masters";
import { Router, type Response } from "express";
import { requireAuth, requireAnyPermission } from "../../auth/middleware.js";
import {
  createPaymentTypeSchema,
  patchPaymentTypeSchema,
} from "../../lib/payment-types/schemas.js";
import { zodValidationErrorBody } from "../../lib/validation-error.js";
import {
  PaymentTypeNotFoundError,
  PaymentTypeValidationError,
  paymentTypesMasterService,
} from "../../services/masters/payment-types.service.js";

const router = Router();
router.use(requireAuth, requireAnyPermission(["module.masters"]));

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof PaymentTypeNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof PaymentTypeValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/", async (_req, res, next) => {
  try {
    res.json({ items: await paymentTypesMasterService.list(false) });
  } catch (e) {
    next(e);
  }
});

router.get("/options", async (_req, res, next) => {
  try {
    res.json(await paymentTypesMasterService.list(true));
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createPaymentTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await paymentTypesMasterService.create(
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
    res.status(400).json({ error: MastersErrorMessages.INVALID_PAYMENT_TYPE_ID });
    return;
  }

  const parsed = patchPaymentTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await paymentTypesMasterService.update(
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

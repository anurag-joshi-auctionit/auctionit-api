import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAnyPermission } from "../../auth/middleware.js";
import { zodValidationErrorBody } from "../../lib/validation-error.js";
import {
  bidderMasterCreateSchema,
  bidderMasterPatchSchema,
  dispositionsMasterListQuerySchema,
} from "../../lib/validation/masters.js";
import {
  MasterConflictError,
  MasterNotFoundError,
  liftingBidderDispositionMasterService,
} from "../../services/masters/lifting-bidder-disposition.service.js";

const router = Router();

router.get("/", requireAuth, requireAnyPermission(["module.masters", "masters.lifting-bidder-disposition.read", "masters.lifting-bidder-disposition.write"]), async (req, res, next) => {
  const parsed = dispositionsMasterListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const result = await liftingBidderDispositionMasterService.listPaginated(parsed.data);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/options", requireAuth, requireAnyPermission(["module.masters", "masters.lifting-bidder-disposition.read", "masters.lifting-bidder-disposition.write"]), async (_req, res, next) => {
  try {
    const rows = await liftingBidderDispositionMasterService.list(true);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuth, requireAnyPermission(["module.masters", "masters.lifting-bidder-disposition.write"]), async (req, res, next) => {
  const parsed = bidderMasterCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await liftingBidderDispositionMasterService.create(
      parsed.data,
      req.user?.id,
    );
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof MasterConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    next(err);
  }
});

router.patch("/:id", requireAuth, requireAnyPermission(["module.masters", "masters.lifting-bidder-disposition.write"]), async (req, res, next) => {
  const parsed = bidderMasterPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  const id = z.string().trim().parse(req.params.id);

  try {
    const row = await liftingBidderDispositionMasterService.update(
      id,
      parsed.data,
      req.user?.id,
    );
    res.json(row);
  } catch (err) {
    if (err instanceof MasterNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof MasterConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    next(err);
  }
});

export default router;

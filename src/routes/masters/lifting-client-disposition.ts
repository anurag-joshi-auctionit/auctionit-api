import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAnyPermission } from "../../auth/middleware.js";
import { zodValidationErrorBody } from "../../lib/validation-error.js";
import {
  dispositionsMasterListQuerySchema,
  masterPatchSchema,
} from "../../lib/validation/masters.js";
import {
  cacheKey,
  invalidateCachePrefix,
  MASTERS_CACHE_TTL_SECONDS,
  withCache,
} from "../../lib/cache.js";
import {
  MasterNotFoundError,
  MasterValidationError,
  liftingClientDispositionMasterService,
} from "../../services/masters/lifting-client-disposition.service.js";

const CACHE_PREFIX = "cache:masters:lifting-client-disposition";

const router = Router();

router.get("/", requireAuth, requireAnyPermission(["module.masters", "masters.lifting-clients-disposition.read", "masters.lifting-clients-disposition.write"]), async (req, res, next) => {
  const parsed = dispositionsMasterListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const result = await withCache(
      cacheKey(CACHE_PREFIX, parsed.data),
      MASTERS_CACHE_TTL_SECONDS,
      () => liftingClientDispositionMasterService.listPaginated(parsed.data),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/options", requireAuth, requireAnyPermission(["module.masters", "masters.lifting-clients-disposition.read", "masters.lifting-clients-disposition.write"]), async (_req, res, next) => {
  try {
    const rows = await withCache(
      `${CACHE_PREFIX}:options`,
      MASTERS_CACHE_TTL_SECONDS,
      () => liftingClientDispositionMasterService.list(true),
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireAuth, requireAnyPermission(["module.masters", "masters.lifting-clients-disposition.write"]), async (req, res, next) => {
  const parsed = masterPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  const id = z.string().trim().parse(req.params.id);

  try {
    const row = await liftingClientDispositionMasterService.update(
      id,
      parsed.data,
      req.user?.id,
    );
    await invalidateCachePrefix(CACHE_PREFIX);
    res.json(row);
  } catch (e) {
    if (e instanceof MasterNotFoundError) {
      res.status(404).json({ error: e.message });
      return;
    }
    if (e instanceof MasterValidationError) {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

export default router;

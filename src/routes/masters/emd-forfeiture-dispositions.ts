import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAnyPermission } from "../../auth/middleware.js";
import { zodValidationErrorBody } from "../../lib/validation-error.js";
import {
  dispositionsMasterListQuerySchema,
  masterCreateSchema,
  masterPatchSchema,
} from "../../lib/validation/masters.js";
import {
  cacheKey,
  invalidateCachePrefix,
  MASTERS_CACHE_TTL_SECONDS,
  withCache,
} from "../../lib/cache.js";
import {
  MasterConflictError,
  MasterNotFoundError,
  emdForfeitureDispositionsMasterService,
} from "../../services/masters/emd-forfeiture-dispositions.service.js";

const CACHE_PREFIX = "cache:masters:emd-forfeiture-dispositions";

const router = Router();

const READ = [
  "module.masters",
  "masters.emd-forfeiture-dispositions.read",
  "masters.emd-forfeiture-dispositions.write",
];
const WRITE = ["module.masters", "masters.emd-forfeiture-dispositions.write"];

router.get("/", requireAuth, requireAnyPermission(READ), async (req, res) => {
  const parsed = dispositionsMasterListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  res.json(
    await withCache(
      cacheKey(CACHE_PREFIX, parsed.data),
      MASTERS_CACHE_TTL_SECONDS,
      () => emdForfeitureDispositionsMasterService.listPaginated(parsed.data),
    ),
  );
});

router.post("/", requireAuth, requireAnyPermission(WRITE), async (req, res) => {
  const parsed = masterCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const row = await emdForfeitureDispositionsMasterService.create(parsed.data, req.user?.id);
    await invalidateCachePrefix(CACHE_PREFIX);
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof MasterConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.patch("/:id", requireAuth, requireAnyPermission(WRITE), async (req, res) => {
  const parsed = masterPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  const id = z.string().trim().parse(req.params.id);
  try {
    const row = await emdForfeitureDispositionsMasterService.update(id, parsed.data, req.user?.id);
    await invalidateCachePrefix(CACHE_PREFIX);
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
    throw err;
  }
});

export default router;

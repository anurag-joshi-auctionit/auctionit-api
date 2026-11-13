import { MastersErrorMessages } from "@auctionit/messages/masters";
import { Router, type Response } from "express";
import { requireAuth, requireAnyPermission } from "../../auth/middleware.js";
import {
  createUomSchema,
  patchUomSchema,
  uomsListQuerySchema,
} from "../../lib/uoms/schemas.js";
import { zodValidationErrorBody } from "../../lib/validation-error.js";
import {
  cacheKey,
  invalidateCachePrefix,
  MASTERS_CACHE_TTL_SECONDS,
  withCache,
} from "../../lib/cache.js";
import {
  UomNotFoundError,
  UomValidationError,
  uomsMasterService,
} from "../../services/masters/uoms.service.js";

const CACHE_PREFIX = "cache:masters:uoms";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.masters"]));

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof UomNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof UomValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/", async (req, res, next) => {
  const parsed = uomsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const result = await withCache(
      cacheKey(CACHE_PREFIX, parsed.data),
      MASTERS_CACHE_TTL_SECONDS,
      () => uomsMasterService.listPaginated(parsed.data),
    );
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/options", async (_req, res, next) => {
  try {
    const rows = await withCache(
      `${CACHE_PREFIX}:options`,
      MASTERS_CACHE_TTL_SECONDS,
      () => uomsMasterService.list(true),
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createUomSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await uomsMasterService.create(parsed.data, req.user?.id);
    await invalidateCachePrefix(CACHE_PREFIX);
    res.status(201).json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: MastersErrorMessages.INVALID_UOM_ID });
    return;
  }

  const parsed = patchUomSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await uomsMasterService.update(id, parsed.data, req.user?.id);
    await invalidateCachePrefix(CACHE_PREFIX);
    res.json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

export default router;

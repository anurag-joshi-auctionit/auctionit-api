import { BenchmarksErrorMessages } from "@auctionit/messages/benchmarks";
import { Router, type Response } from "express";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import {
  benchmarkCombosListQuerySchema,
  benchmarkEntitySearchQuerySchema,
  createBenchmarkComboSchema,
  patchBenchmarkComboSchema,
} from "../lib/benchmarks/schemas.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  BenchmarkComboNotFoundError,
  BenchmarkComboValidationError,
  benchmarkMaterialLocationsService,
} from "../services/benchmark-material-locations.service.js";
import { FxRateUnavailableError } from "../services/fx-rates.service.js";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.inventory", "benchmark.read"]));

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleComboError(e: unknown, res: Response): boolean {
  if (e instanceof BenchmarkComboNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof BenchmarkComboValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  if (e instanceof FxRateUnavailableError) {
    res.status(503).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/stats", async (_req, res, next) => {
  try {
    const counts = await benchmarkMaterialLocationsService.getCounts();
    res.json(counts);
  } catch (e) {
    next(e);
  }
});

router.get("/locations", async (_req, res, next) => {
  try {
    const locations = await benchmarkMaterialLocationsService.listActiveLocations();
    res.json(locations);
  } catch (e) {
    next(e);
  }
});

router.get("/materials", async (_req, res, next) => {
  try {
    const materials = await benchmarkMaterialLocationsService.listActiveMaterials();
    res.json(materials);
  } catch (e) {
    next(e);
  }
});

router.get("/benchmark-materials", async (req, res, next) => {
  const parsed = benchmarkEntitySearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const options = await benchmarkMaterialLocationsService.searchMaterials(parsed.data.search);
    res.json(options);
  } catch (e) {
    next(e);
  }
});

router.get("/benchmark-locations", async (req, res, next) => {
  const parsed = benchmarkEntitySearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const options = await benchmarkMaterialLocationsService.searchLocations(parsed.data.search);
    res.json(options);
  } catch (e) {
    next(e);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const parsed = benchmarkCombosListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    const result = await benchmarkMaterialLocationsService.list(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: BenchmarksErrorMessages.INVALID_COMBO_ID });
    return;
  }
  try {
    const row = await benchmarkMaterialLocationsService.get(id);
    if (!row) {
      res.status(404).json({ error: BenchmarksErrorMessages.COMBO_NOT_FOUND });
      return;
    }
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createBenchmarkComboSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const created = await benchmarkMaterialLocationsService.create(
      parsed.data,
      req.user?.id,
    );
    res.status(201).json(created);
  } catch (e) {
    if (handleComboError(e, res)) return;
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: BenchmarksErrorMessages.INVALID_COMBO_ID });
    return;
  }
  const parsed = patchBenchmarkComboSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const updated = await benchmarkMaterialLocationsService.update(
      id,
      parsed.data,
      req.user?.id,
    );
    res.json(updated);
  } catch (e) {
    if (handleComboError(e, res)) return;
    next(e);
  }
});

export default router;

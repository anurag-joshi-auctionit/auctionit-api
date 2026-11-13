import { BenchmarksErrorMessages } from "@auctionit/messages/benchmarks";
import { Router, type Response } from "express";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import {
  benchmarkPriceHistoryQuerySchema,
  benchmarkPricesBulkSchema,
  benchmarkPricesGridQuerySchema,
  benchmarkPricesListQuerySchema,
} from "../lib/benchmarks/schemas.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  BenchmarkComboNotFoundError,
  benchmarkMaterialLocationsService,
} from "../services/benchmark-material-locations.service.js";
import { benchmarkPricesService } from "../services/benchmark-prices.service.js";
import { FxRateUnavailableError } from "../services/fx-rates.service.js";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.inventory", "benchmark.read"]));

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handlePriceError(e: unknown, res: Response): boolean {
  if (e instanceof BenchmarkComboNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof FxRateUnavailableError) {
    res.status(503).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/grid", async (req, res, next) => {
  try {
    const parsed = benchmarkPricesGridQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    const result = await benchmarkPricesService.grid(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const parsed = benchmarkPricesListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    const result = await benchmarkPricesService.list(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/history/:comboId", async (req, res, next) => {
  const comboId = parseId(req.params.comboId);
  if (comboId === null) {
    res.status(400).json({ error: BenchmarksErrorMessages.INVALID_COMBO_ID });
    return;
  }
  try {
    const parsed = benchmarkPriceHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(zodValidationErrorBody(parsed.error));
      return;
    }
    const result = await benchmarkPricesService.history(comboId, parsed.data);
    res.json(result);
  } catch (e) {
    if (handlePriceError(e, res)) return;
    next(e);
  }
});

router.post("/bulk", async (req, res, next) => {
  const parsed = benchmarkPricesBulkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await benchmarkPricesService.bulkUpsert(
      parsed.data,
      req.user?.id,
    );
    res.json(result);
  } catch (e) {
    if (handlePriceError(e, res)) return;
    next(e);
  }
});

export default router;

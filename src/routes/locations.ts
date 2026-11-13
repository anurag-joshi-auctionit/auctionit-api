import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import { locationsService } from "../services/locations.service.js";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.clients", "clients.read", "module.auctions", "auctions.read"]));

router.get("/countries", async (_req, res, next) => {
  try {
    const items = await locationsService.listCountries();
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.get("/states", async (req, res, next) => {
  const parsed = z.object({ country: z.string().trim().min(1) }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const items = await locationsService.listStates(parsed.data.country);
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.get("/cities", async (req, res, next) => {
  const parsed = z
    .object({
      country: z.string().trim().min(1),
      state: z.string().trim().min(1),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const items = await locationsService.listCities(
      parsed.data.country,
      parsed.data.state,
    );
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.get("/search", async (req, res, next) => {
  const parsed = z
    .object({
      q: z.string().trim().optional().default(""),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const items = await locationsService.search(
      parsed.data.q,
      parsed.data.limit,
    );
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

export default router;

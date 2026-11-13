import { MaterialsErrorMessages } from "@auctionit/messages/masters";
import { Router, type Response } from "express";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import {
  createMaterialSchema,
  materialsExportQuerySchema,
  materialsListQuerySchema,
  patchMaterialSchema,
} from "../lib/materials/schemas.js";
import {
  buildMaterialsExportFilename,
  buildMaterialsExportXlsx,
} from "../lib/materials/materials-export-xlsx.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  MaterialNotFoundError,
  MaterialValidationError,
  materialsService,
} from "../services/materials.service.js";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.inventory", "materials.read"]));

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleMaterialError(e: unknown, res: Response): boolean {
  if (e instanceof MaterialNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof MaterialValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/stats", async (_req, res, next) => {
  try {
    const counts = await materialsService.getCounts();
    res.json(counts);
  } catch (e) {
    next(e);
  }
});

router.get("/", async (req, res, next) => {
  try {
    if (req.query.page != null) {
      const parsed = materialsListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json(zodValidationErrorBody(parsed.error));
        return;
      }
      const result = await materialsService.listPaginated(parsed.data);
      res.json(result);
      return;
    }

    const activeOnly = req.query.activeOnly === "true";
    const items = await materialsService.list(activeOnly);
    res.json(items);
  } catch (e) {
    next(e);
  }
});

router.get("/export", async (req, res, next) => {
  const parsed = materialsExportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const rows = await materialsService.export(parsed.data);
    const buffer = await buildMaterialsExportXlsx(rows);
    const filename = buildMaterialsExportFilename();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createMaterialSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const created = await materialsService.create(parsed.data, req.user?.id);
    res.status(201).json(created);
  } catch (e) {
    if (handleMaterialError(e, res)) return;
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: MaterialsErrorMessages.INVALID_MATERIAL_ID });
    return;
  }
  const parsed = patchMaterialSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const updated = await materialsService.update(id, parsed.data, req.user?.id);
    res.json(updated);
  } catch (e) {
    if (handleMaterialError(e, res)) return;
    next(e);
  }
});

export default router;

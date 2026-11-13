import { Router, type Response } from "express";
import { z } from "zod";
import {
  ItemsErrorMessages,
  ItemsValidationMessages,
} from "@auctionit/messages/items";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import {
  createItemSchema,
  itemsExportQuerySchema,
  itemsListQuerySchema,
  itemsStatsQuerySchema,
  patchItemSchema,
} from "../lib/items/schemas.js";
import { buildItemsExportFilename, buildItemsExportXlsx } from "../lib/items/items-export-xlsx.js";
import { entityOptionsQuerySchema, entityOptionIdsQuerySchema } from "../lib/options-query.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import {
  MaterialNotFoundError,
} from "../services/materials.service.js";
import {
  ItemBenchmarkMaterialNotFoundError,
  ItemClientNotFoundError,
  ItemDuplicateNameError,
  ItemNotFoundError,
  itemsService,
} from "../services/items.service.js";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.inventory", "items.read"]));

const itemsOptionsQuerySchema = entityOptionsQuerySchema.extend({
  clientId: z.coerce.number().int().positive(),
});

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleItemError(e: unknown, res: Response): boolean {
  if (e instanceof ItemNotFoundError) {
    res.status(404).json({ error: ItemsErrorMessages.ITEM_NOT_FOUND });
    return true;
  }
  if (e instanceof ItemClientNotFoundError) {
    res.status(400).json(
      fieldValidationErrorBody(
        { clientId: [ItemsErrorMessages.CLIENT_NOT_FOUND] },
        ItemsErrorMessages.CLIENT_NOT_FOUND,
      ),
    );
    return true;
  }
  if (e instanceof MaterialNotFoundError) {
    res.status(400).json(
      fieldValidationErrorBody(
        { materialId: [ItemsValidationMessages.MATERIAL_NOT_FOUND] },
        ItemsValidationMessages.MATERIAL_NOT_FOUND,
      ),
    );
    return true;
  }
  if (e instanceof ItemBenchmarkMaterialNotFoundError) {
    res.status(400).json(
      fieldValidationErrorBody(
        {
          benchmarkMaterialId: [
            ItemsValidationMessages.BENCHMARK_MATERIAL_NOT_FOUND,
          ],
        },
        ItemsValidationMessages.BENCHMARK_MATERIAL_NOT_FOUND,
      ),
    );
    return true;
  }
  if (e instanceof ItemDuplicateNameError) {
    res.status(400).json(
      fieldValidationErrorBody(
        { name: [ItemsValidationMessages.ITEM_NAME_EXISTS] },
        ItemsValidationMessages.ITEM_NAME_EXISTS,
      ),
    );
    return true;
  }
  return false;
}

router.get("/stats", async (req, res, next) => {
  const parsed = itemsStatsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const counts = await itemsService.getCounts(parsed.data.clientId);
    res.json(counts);
  } catch (e) {
    next(e);
  }
});

router.get("/options", async (req, res, next) => {
  const parsed = itemsOptionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const options = await itemsService.listActiveOptions({
      clientId: parsed.data.clientId,
      q: parsed.data.q,
      limit: parsed.data.limit,
      ids: parsed.data.ids,
    });
    res.json({ options });
  } catch (e) {
    next(e);
  }
});

router.get("/options/ids", async (req, res, next) => {
  const parsed = entityOptionIdsQuerySchema
    .extend({
      clientId: z.coerce.number().int().positive(),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await itemsService.listActiveOptionIds({
      clientId: parsed.data.clientId,
      q: parsed.data.q,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/", async (req, res, next) => {
  const parsed = itemsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await itemsService.list(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/export", async (req, res, next) => {
  const parsed = itemsExportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const rows = await itemsService.export(parsed.data);
    const buffer = await buildItemsExportXlsx(rows);
    const filename = buildItemsExportFilename();
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

router.get("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ItemsErrorMessages.INVALID_ITEM_ID });
    return;
  }
  try {
    const item = await itemsService.get(id);
    if (!item) {
      res.status(404).json({ error: ItemsErrorMessages.ITEM_NOT_FOUND });
      return;
    }
    res.json(item);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const created = await itemsService.create(parsed.data, req.user?.id);
    res.status(201).json(created);
  } catch (e) {
    if (handleItemError(e, res)) return;
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: ItemsErrorMessages.INVALID_ITEM_ID });
    return;
  }
  const parsed = patchItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const updated = await itemsService.update(id, parsed.data, req.user?.id);
    res.json(updated);
  } catch (e) {
    if (handleItemError(e, res)) return;
    next(e);
  }
});

export default router;

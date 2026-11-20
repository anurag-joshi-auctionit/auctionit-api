import { Router, type Response } from "express";
import { requireAuth, requireAnyPermission } from "../auth/middleware.js";
import {
  questionTemplateInputSchema,
  questionTemplatesListQuerySchema,
} from "../lib/question-templates/schemas.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  QuestionTemplateNotFoundError,
  questionTemplatesService,
} from "../services/question-templates/question-templates.service.js";

const router = Router();

router.use(requireAuth);

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof QuestionTemplateNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/", requireAnyPermission(["question-templates.read", "question-templates.write"]), async (req, res, next) => {
  const parsed = questionTemplatesListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const result = await questionTemplatesService.listPaginated(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireAnyPermission(["question-templates.read", "question-templates.write"]), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid question template id." });
    return;
  }

  try {
    const row = await questionTemplatesService.getById(id);
    res.json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.post("/", requireAnyPermission(["question-templates.write"]), async (req, res, next) => {
  const parsed = questionTemplateInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  const userId = req.user?.id ?? 1;

  try {
    const row = await questionTemplatesService.create(parsed.data, userId);
    res.status(201).json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.patch("/:id", requireAnyPermission(["question-templates.write"]), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid question template id." });
    return;
  }

  const parsed = questionTemplateInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  const userId = req.user?.id ?? 1;

  try {
    const row = await questionTemplatesService.update(id, parsed.data, userId);
    res.json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

export default router;

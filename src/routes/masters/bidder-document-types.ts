import { MastersErrorMessages } from "@auctionit/messages/masters";
import { Router, type Response } from "express";
import { requireAuth, requireAnyPermission } from "../../auth/middleware.js";
import {
  bidderDocumentTypesListQuerySchema,
  createBidderDocumentTypeSchema,
  patchBidderDocumentTypeSchema,
} from "../../lib/bidder-document-types/schemas.js";
import { zodValidationErrorBody } from "../../lib/validation-error.js";
import {
  BidderDocumentTypeNotFoundError,
  BidderDocumentTypeValidationError,
  bidderDocumentTypesMasterService,
} from "../../services/masters/bidder-document-types.service.js";

const router = Router();

router.use(requireAuth, requireAnyPermission(["module.masters"]));

function parseId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof BidderDocumentTypeNotFoundError) {
    res.status(404).json({ error: e.message });
    return true;
  }
  if (e instanceof BidderDocumentTypeValidationError) {
    res.status(400).json({ error: e.message });
    return true;
  }
  return false;
}

router.get("/", async (req, res, next) => {
  const parsed = bidderDocumentTypesListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const result = await bidderDocumentTypesMasterService.listPaginated(
      parsed.data,
    );
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get("/options", async (_req, res, next) => {
  try {
    const rows = await bidderDocumentTypesMasterService.list(true);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = createBidderDocumentTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await bidderDocumentTypesMasterService.create(
      parsed.data,
      req.user?.id,
    );
    res.status(201).json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

router.patch("/:id", async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: MastersErrorMessages.INVALID_DOCUMENT_TYPE_ID });
    return;
  }

  const parsed = patchBidderDocumentTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }

  try {
    const row = await bidderDocumentTypesMasterService.update(
      id,
      parsed.data,
      req.user?.id,
    );
    res.json(row);
  } catch (e) {
    if (handleError(e, res)) return;
    next(e);
  }
});

export default router;

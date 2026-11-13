import { Router } from "express";
import { z } from "zod";
import {
  FilesErrorMessages,
  FilesValidationMessages,
} from "@auctionit/messages/files";
import { requireAuth } from "../auth/middleware.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  ALLOWED_FILE_EXTENSIONS,
  filesService,
  isAllowedExtension,
} from "../services/files.service.js";

const router = Router();
router.use(requireAuth);

const MAX_MB = 20;
const MAX_BYTES = MAX_MB * 1024 * 1024;

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(255).optional(),
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_BYTES * 4) / 3) + 1024),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z.enum(["createdAt", "filename"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

router.get("/", async (req, res, next) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await filesService.listForUser(req.user!.id, parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Lets the client fetch the accepted extensions to drive its file picker.
router.get("/allowed-extensions", (_req, res) => {
  res.json({ extensions: ALLOWED_FILE_EXTENSIONS });
});

router.get("/:id/download", async (req, res, next) => {
  const fileId = Number(req.params.id);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    res.status(400).json({ error: FilesErrorMessages.INVALID_FILE_ID });
    return;
  }
  try {
    const url = await filesService.getSignedUrlForUser(req.user!.id, fileId);
    if (!url) {
      res.status(404).json({ error: FilesErrorMessages.FILE_NOT_FOUND });
      return;
    }
    res.json({ url });
  } catch (e) {
    next(e);
  }
});

router.post("/", async (req, res, next) => {
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  if (!isAllowedExtension(parsed.data.filename)) {
    res.status(400).json({
      error: FilesValidationMessages.FILE_TYPE_INVALID(
        ALLOWED_FILE_EXTENSIONS.join(", "),
      ),
    });
    return;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(parsed.data.dataBase64, "base64");
  } catch {
    res.status(400).json({ error: FilesValidationMessages.INVALID_BASE64 });
    return;
  }
  if (buf.length === 0) {
    res.status(400).json({ error: FilesValidationMessages.FILE_EMPTY });
    return;
  }
  if (buf.length > MAX_BYTES) {
    res.status(413).json({
      error: FilesValidationMessages.FILE_TOO_LARGE(MAX_MB),
    });
    return;
  }
  try {
    const item = await filesService.upload({
      userId: req.user!.id,
      filename: parsed.data.filename,
      contentType: parsed.data.contentType,
      body: buf,
    });
    res.status(201).json({ file: item });
  } catch (e) {
    next(e);
  }
});

export default router;

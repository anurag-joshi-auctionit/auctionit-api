import { z } from "zod";
import { ErrorBody, IdParam } from "../common.js";
import { documentRouter } from "../define.js";
import { FileAllowedExtensions, FileList, FileSignedUrl, FileUploadResult } from "../responses/files.js";

// Docs for src/routes/files.ts — see docs/api/README.md.
const r = documentRouter("/files");

// Recreated from src/routes/files.ts (schemas are defined inline there).
const MAX_BYTES = 20 * 1024 * 1024;

const filesListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional().describe("Case-insensitive filename substring."),
  sortBy: z.enum(["createdAt", "filename"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

const filesUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255).describe("Original filename; its extension must be allowed."),
  contentType: z.string().trim().max(255).optional(),
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_BYTES * 4) / 3) + 1024)
    .describe("File contents, base64-encoded. Decoded size is capped at 20 MB."),
});

r.get("/", {
  summary: "List my files",
  description: "Paginated list of files uploaded by the current user. Rows carry no signed URL.",
  query: filesListQuerySchema,
  responses: { 200: FileList },
});

r.get("/allowed-extensions", {
  summary: "Allowed upload extensions",
  description: "Extensions accepted by POST /files, for driving a file picker.",
  responses: { 200: FileAllowedExtensions },
});

r.get("/:id/download", {
  summary: "Get a download URL",
  description: "Returns a signed URL for one of the current user's files (JSON, not a redirect).",
  params: IdParam,
  responses: {
    200: FileSignedUrl,
    400: { description: "Invalid file id.", schema: ErrorBody },
    404: { description: "File not found or not owned by the current user.", schema: ErrorBody },
  },
});

r.post("/", {
  summary: "Upload a file",
  description:
    "JSON upload with base64 contents (not multipart). The extension must be in GET /files/allowed-extensions.",
  body: filesUploadSchema,
  responses: {
    201: { description: "Stored file, with a signed download URL.", schema: FileUploadResult },
    400: {
      description: "Invalid input, disallowed file type, invalid base64, or empty file.",
      schema: ErrorBody,
    },
    413: { description: "Decoded file is larger than 20 MB.", schema: ErrorBody },
  },
});

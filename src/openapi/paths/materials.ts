import { z } from "zod";
import { MATERIALS_EXPORT_MAX_ROWS } from "../../lib/materials/export-constants.js";
import {
  createMaterialSchema,
  materialsExportQuerySchema,
  materialsListQuerySchema,
  patchMaterialSchema,
} from "../../lib/materials/schemas.js";
import { BinaryFile, ErrorBody, IdParam } from "../common.js";
import { documentRouter } from "../define.js";
import { Material, MaterialCounts, MaterialListResponse } from "../responses/materials.js";

// Docs for src/routes/materials.ts — see docs/api/README.md.
const r = documentRouter("/materials");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

r.get("/stats", {
  summary: "Material counts",
  description: "Total / active / inactive material counts.",
  responses: { 200: MaterialCounts },
});

r.get("/", {
  summary: "List materials",
  description:
    "Two modes. With `page` in the query: a paginated, filterable list (`materialsListQuerySchema`) with " +
    "status-tab counts. Without `page`: the whole material tree as a flat array ordered by depth then label; " +
    "only `activeOnly=true` is honoured in that mode.",
  query: materialsListQuerySchema.extend({
    activeOnly: z
      .enum(["true", "false"])
      .optional()
      .describe("Unpaginated mode only: `true` returns active materials only."),
  }),
  responses: { 200: MaterialListResponse },
});

r.get("/export", {
  summary: "Export filtered materials",
  description: `All materials matching the list filters, as \`materials-export-<yyyy-MM-dd>.xlsx\`. Same filters as the paginated list mode, minus pagination; capped at ${MATERIALS_EXPORT_MAX_ROWS.toLocaleString()} rows.`,
  query: materialsExportQuerySchema,
  responses: {
    200: { description: "Materials workbook.", schema: BinaryFile, contentType: XLSX },
  },
});

r.post("/", {
  summary: "Create material",
  description: "Creates a root material, or a child when `parentId` is set (depth = parent depth + 1).",
  body: createMaterialSchema,
  responses: {
    201: { description: "Created material.", schema: Material },
    400: { description: "Invalid input, or the parent does not exist.", schema: ErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update material",
  description:
    "Partial update; at least one field is required. Changing `parentId` moves the material (and its " +
    "descendants' depths) in the tree; moving under itself or a descendant is rejected.",
  params: IdParam,
  body: patchMaterialSchema,
  responses: {
    200: Material,
    400: { description: "Invalid id or input, or an invalid re-parenting.", schema: ErrorBody },
    404: { description: "Material not found.", schema: ErrorBody },
  },
});

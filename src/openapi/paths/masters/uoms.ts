import { createUomSchema, patchUomSchema, uomsListQuerySchema } from "../../../lib/uoms/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import { MasterUom, MasterUomList, MasterUomOptions } from "../../responses/masters/uoms.js";

// Docs for src/routes/masters/uoms.ts — see docs/api/README.md.
const r = documentRouter("/masters/uoms");

r.get("/", {
  summary: "List units of measure",
  description: "Paginated UOM master list.",
  query: uomsListQuerySchema,
  responses: { 200: MasterUomList },
});

r.get("/options", {
  summary: "Active units of measure",
  responses: { 200: MasterUomOptions },
});

r.post("/", {
  summary: "Create unit of measure",
  description: "Codes are unique case-insensitively.",
  body: createUomSchema,
  responses: {
    201: { description: "Created UOM.", schema: MasterUom },
    400: { description: "Invalid input, duplicate code, or the UOM id range is exhausted.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update unit of measure",
  description: "At least one field is required.",
  params: IdParam,
  body: patchUomSchema,
  responses: {
    200: MasterUom,
    400: { description: "Invalid id or input, or another UOM already has this code.", schema: ValidationErrorBody },
    404: { description: "UOM not found.", schema: ErrorBody },
  },
});

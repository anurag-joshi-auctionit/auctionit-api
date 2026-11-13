import {
  benchmarkMaterialsListQuerySchema,
  createBenchmarkMaterialMasterSchema,
  patchBenchmarkMaterialMasterSchema,
} from "../../../lib/benchmark-materials/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterBenchmarkMaterial,
  MasterBenchmarkMaterialList,
  MasterBenchmarkMaterialOptions,
} from "../../responses/masters/benchmark-materials.js";

// Docs for src/routes/masters/benchmark-materials.ts — see docs/api/README.md.
const r = documentRouter("/masters/benchmark-materials");

r.get("/", {
  summary: "List benchmark materials",
  description: "Paginated master list. `search` matches name or id; `activeOnly=true` hides inactive rows.",
  query: benchmarkMaterialsListQuerySchema,
  responses: { 200: MasterBenchmarkMaterialList },
});

r.get("/options", {
  summary: "Active benchmark materials",
  description: "All active benchmark materials for select inputs, ordered by name.",
  responses: { 200: MasterBenchmarkMaterialOptions },
});

r.post("/", {
  summary: "Create benchmark material",
  body: createBenchmarkMaterialMasterSchema,
  responses: {
    201: { description: "Created benchmark material.", schema: MasterBenchmarkMaterial },
    400: { description: "Invalid input, or a benchmark material with this name already exists.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update benchmark material",
  description: "Rename and/or activate/deactivate. At least one field is required.",
  params: IdParam,
  body: patchBenchmarkMaterialMasterSchema,
  responses: {
    200: MasterBenchmarkMaterial,
    400: {
      description: "Invalid id or input, or another benchmark material already has this name.",
      schema: ValidationErrorBody,
    },
    404: { description: "Benchmark material not found.", schema: ErrorBody },
  },
});

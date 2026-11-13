import {
  benchmarkLocationsListQuerySchema,
  createBenchmarkLocationMasterSchema,
  patchBenchmarkLocationMasterSchema,
} from "../../../lib/benchmark-locations/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterBenchmarkLocation,
  MasterBenchmarkLocationList,
  MasterBenchmarkLocationOptions,
} from "../../responses/masters/benchmark-locations.js";

// Docs for src/routes/masters/benchmark-locations.ts — see docs/api/README.md.
const r = documentRouter("/masters/benchmark-locations");

r.get("/", {
  summary: "List benchmark locations",
  description: "Paginated master list. `search` matches name or id; `activeOnly=true` hides inactive rows.",
  query: benchmarkLocationsListQuerySchema,
  responses: { 200: MasterBenchmarkLocationList },
});

r.get("/options", {
  summary: "Active benchmark locations",
  description: "All active benchmark locations for select inputs, ordered by name.",
  responses: { 200: MasterBenchmarkLocationOptions },
});

r.post("/", {
  summary: "Create benchmark location",
  body: createBenchmarkLocationMasterSchema,
  responses: {
    201: { description: "Created benchmark location.", schema: MasterBenchmarkLocation },
    400: { description: "Invalid input, or a benchmark location with this name already exists.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update benchmark location",
  description: "Rename and/or activate/deactivate. At least one field is required.",
  params: IdParam,
  body: patchBenchmarkLocationMasterSchema,
  responses: {
    200: MasterBenchmarkLocation,
    400: {
      description: "Invalid id or input, or another benchmark location already has this name.",
      schema: ValidationErrorBody,
    },
    404: { description: "Benchmark location not found.", schema: ErrorBody },
  },
});

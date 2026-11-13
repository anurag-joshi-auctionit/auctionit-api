import {
  benchmarkCombosListQuerySchema,
  benchmarkEntitySearchQuerySchema,
  createBenchmarkComboSchema,
  patchBenchmarkComboSchema,
} from "../../lib/benchmarks/schemas.js";
import { ErrorBody, IdParam } from "../common.js";
import { documentRouter } from "../define.js";
import {
  BenchmarkCombo,
  BenchmarkComboCounts,
  BenchmarkComboList,
  BenchmarkEntityOptionList,
  BenchmarkStringList,
} from "../responses/benchmark-material-locations.js";

// Docs for src/routes/benchmark-material-locations.ts — see docs/api/README.md.
const r = documentRouter("/benchmark-material-locations");

r.get("/stats", {
  summary: "Benchmark combo counts",
  description: "Total / active / inactive material-location combo counts.",
  responses: { 200: BenchmarkComboCounts },
});

r.get("/locations", {
  summary: "Distinct active locations",
  description: "Sorted distinct `location` values across active combos (for filters).",
  responses: { 200: BenchmarkStringList },
});

r.get("/materials", {
  summary: "Distinct active materials",
  description: "Sorted distinct `material` values across active combos (for filters).",
  responses: { 200: BenchmarkStringList },
});

r.get("/benchmark-materials", {
  summary: "Search benchmark materials",
  description: "Up to 50 benchmark materials matching `search` (or the most recent, if omitted).",
  query: benchmarkEntitySearchQuerySchema,
  responses: { 200: BenchmarkEntityOptionList },
});

r.get("/benchmark-locations", {
  summary: "Search benchmark locations",
  description: "Up to 50 benchmark locations matching `search` (or the most recent, if omitted).",
  query: benchmarkEntitySearchQuerySchema,
  responses: { 200: BenchmarkEntityOptionList },
});

r.get("/", {
  summary: "List benchmark combos",
  description: "Paginated material-location combos with status-tab counts.",
  query: benchmarkCombosListQuerySchema,
  responses: { 200: BenchmarkComboList },
});

r.get("/:id", {
  summary: "Get benchmark combo",
  params: IdParam,
  responses: {
    200: BenchmarkCombo,
    400: { description: "Invalid benchmark id.", schema: ErrorBody },
    404: { description: "Benchmark not found.", schema: ErrorBody },
  },
});

r.post("/", {
  summary: "Create benchmark combo",
  description:
    "References an existing benchmark material and location by id (create them first via " +
    "POST /masters/benchmark-materials and /masters/benchmark-locations); a material + location pair must be unique.",
  body: createBenchmarkComboSchema,
  responses: {
    201: { description: "Created combo.", schema: BenchmarkCombo },
    400: { description: "Invalid input, or the material + location pair already exists.", schema: ErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update benchmark combo",
  description:
    "Partial update; at least one field is required. Changing `currency` re-converts the combo's existing " +
    "prices to INR using the exchange rate of each price date.",
  params: IdParam,
  body: patchBenchmarkComboSchema,
  responses: {
    200: BenchmarkCombo,
    400: { description: "Invalid id or input, or the material + location pair already exists.", schema: ErrorBody },
    404: { description: "Benchmark not found.", schema: ErrorBody },
    503: { description: "No exchange rate available to re-convert existing prices.", schema: ErrorBody },
  },
});

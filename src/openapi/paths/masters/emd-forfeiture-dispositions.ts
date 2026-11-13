import {
  dispositionsMasterListQuerySchema,
  masterCreateSchema,
  masterPatchSchema,
} from "../../../lib/validation/masters.js";
import { ErrorBody, IdParam } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterEmdForfeitureDisposition,
  MasterEmdForfeitureDispositionList,
} from "../../responses/masters/emd-forfeiture-dispositions.js";

// Docs for src/routes/masters/emd-forfeiture-dispositions.ts — see docs/api/README.md.
const r = documentRouter("/masters/emd-forfeiture-dispositions");

r.get("/", {
  summary: "List EMD forfeiture dispositions",
  description: "Paginated master list of reasons an EMD can be forfeited.",
  query: dispositionsMasterListQuerySchema,
  responses: { 200: MasterEmdForfeitureDispositionList },
});

r.post("/", {
  summary: "Create EMD forfeiture disposition",
  description: "New rows are active. Labels are unique case-insensitively.",
  body: masterCreateSchema,
  responses: {
    201: { description: "Created disposition.", schema: MasterEmdForfeitureDisposition },
    409: { description: "A disposition with this label already exists.", schema: ErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update EMD forfeiture disposition",
  description: "Partial update; an empty body only bumps `updatedAt`.",
  params: IdParam,
  body: masterPatchSchema,
  responses: {
    200: MasterEmdForfeitureDisposition,
    404: { description: "Disposition not found (or the id is not a positive integer).", schema: ErrorBody },
    409: { description: "Another disposition already has this label.", schema: ErrorBody },
  },
});

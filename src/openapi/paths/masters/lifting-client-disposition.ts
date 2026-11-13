import { dispositionsMasterListQuerySchema, masterPatchSchema } from "../../../lib/validation/masters.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterLiftingClientDisposition,
  MasterLiftingClientDispositionList,
  MasterLiftingClientDispositionOptions,
} from "../../responses/masters/lifting-client-disposition.js";

// Docs for src/routes/masters/lifting-client-disposition.ts — see docs/api/README.md.
const r = documentRouter("/masters/lifting-clients-disposition");

r.get("/", {
  summary: "List lifting client dispositions",
  description: "Paginated master list of lifting statuses at client level. Rows are fixed; there is no create route.",
  query: dispositionsMasterListQuerySchema,
  responses: { 200: MasterLiftingClientDispositionList },
});

r.get("/options", {
  summary: "Active lifting client dispositions",
  responses: { 200: MasterLiftingClientDispositionOptions },
});

r.patch("/:id", {
  summary: "Update lifting client disposition",
  description: "Partial update of label/description/active flag. The OPEN disposition cannot be deactivated.",
  params: IdParam,
  body: masterPatchSchema,
  responses: {
    200: MasterLiftingClientDisposition,
    400: { description: "Invalid input, or an attempt to deactivate the OPEN disposition.", schema: ValidationErrorBody },
    404: { description: "Disposition not found (or the id is not a positive integer).", schema: ErrorBody },
  },
});

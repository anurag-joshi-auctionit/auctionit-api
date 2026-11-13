import {
  bidderMasterCreateSchema,
  bidderMasterPatchSchema,
  dispositionsMasterListQuerySchema,
} from "../../../lib/validation/masters.js";
import { ErrorBody, IdParam } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterLiftingBidderDisposition,
  MasterLiftingBidderDispositionList,
  MasterLiftingBidderDispositionOptions,
} from "../../responses/masters/lifting-bidder-disposition.js";

// Docs for src/routes/masters/lifting-bidder-disposition.ts — see docs/api/README.md.
const r = documentRouter("/masters/lifting-bidder-disposition");

r.get("/", {
  summary: "List lifting bidder dispositions",
  description: "Paginated master list of follow-up outcomes recorded against bidders during lifting.",
  query: dispositionsMasterListQuerySchema,
  responses: { 200: MasterLiftingBidderDispositionList },
});

r.get("/options", {
  summary: "Active lifting bidder dispositions",
  responses: { 200: MasterLiftingBidderDispositionOptions },
});

r.post("/", {
  summary: "Create lifting bidder disposition",
  description: "New rows are active. Fails when the exact label already exists.",
  body: bidderMasterCreateSchema,
  responses: {
    201: { description: "Created disposition.", schema: MasterLiftingBidderDisposition },
    409: { description: "A row with this label already exists.", schema: ErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update lifting bidder disposition",
  description: "Partial update; an empty body returns the row unchanged.",
  params: IdParam,
  body: bidderMasterPatchSchema,
  responses: {
    200: MasterLiftingBidderDisposition,
    404: { description: "Disposition not found (or the id is not a positive integer).", schema: ErrorBody },
    409: { description: "Another disposition already uses this label.", schema: ErrorBody },
  },
});

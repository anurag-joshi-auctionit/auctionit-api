import {
  bidderDocumentTypesListQuerySchema,
  createBidderDocumentTypeSchema,
  patchBidderDocumentTypeSchema,
} from "../../../lib/bidder-document-types/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterBidderDocumentType,
  MasterBidderDocumentTypeList,
  MasterBidderDocumentTypeOptions,
} from "../../responses/masters/bidder-document-types.js";

// Docs for src/routes/masters/bidder-document-types.ts — see docs/api/README.md.
const r = documentRouter("/masters/bidder-document-types");

r.get("/", {
  summary: "List bidder document types",
  description: "Paginated master list. `search` matches name, file-name prefix or id; `activeOnly=true` hides inactive rows.",
  query: bidderDocumentTypesListQuerySchema,
  responses: { 200: MasterBidderDocumentTypeList },
});

r.get("/options", {
  summary: "Active bidder document types",
  description: "All active bidder document types for select inputs, ordered by id.",
  responses: { 200: MasterBidderDocumentTypeOptions },
});

r.post("/", {
  summary: "Create bidder document type",
  description: "The id is the next free integer and the file-name prefix is derived from it.",
  body: createBidderDocumentTypeSchema,
  responses: {
    201: { description: "Created document type.", schema: MasterBidderDocumentType },
    400: { description: "Invalid input, or a document type with this name already exists.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update bidder document type",
  description: "Rename and/or activate/deactivate. At least one field is required.",
  params: IdParam,
  body: patchBidderDocumentTypeSchema,
  responses: {
    200: MasterBidderDocumentType,
    400: {
      description: "Invalid id or input, or another document type already has this name.",
      schema: ValidationErrorBody,
    },
    404: { description: "Document type not found.", schema: ErrorBody },
  },
});

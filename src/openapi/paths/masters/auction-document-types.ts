import {
  auctionDocumentTypesListQuerySchema,
  createAuctionDocumentTypeSchema,
  patchAuctionDocumentTypeSchema,
} from "../../../lib/auction-document-types/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterAuctionDocumentType,
  MasterAuctionDocumentTypeList,
  MasterAuctionDocumentTypeOptions,
} from "../../responses/masters/auction-document-types.js";

// Docs for src/routes/masters/auction-document-types.ts — see docs/api/README.md.
const r = documentRouter("/masters/auction-document-types");

r.get("/", {
  summary: "List auction document types",
  description: "Paginated master list. `search` matches name, file-name prefix or id; `activeOnly=true` hides inactive rows.",
  query: auctionDocumentTypesListQuerySchema,
  responses: { 200: MasterAuctionDocumentTypeList },
});

r.get("/options", {
  summary: "Active auction document types",
  description: "All active auction document types for select inputs, ordered by id.",
  responses: { 200: MasterAuctionDocumentTypeOptions },
});

r.post("/", {
  summary: "Create auction document type",
  description: "The id is the next free integer and the file-name prefix is derived from it.",
  body: createAuctionDocumentTypeSchema,
  responses: {
    201: { description: "Created document type.", schema: MasterAuctionDocumentType },
    400: { description: "Invalid input, or a document type with this name already exists.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update auction document type",
  description: "Rename and/or activate/deactivate. At least one field is required.",
  params: IdParam,
  body: patchAuctionDocumentTypeSchema,
  responses: {
    200: MasterAuctionDocumentType,
    400: {
      description: "Invalid id or input, or another document type already has this name.",
      schema: ValidationErrorBody,
    },
    404: { description: "Document type not found.", schema: ErrorBody },
  },
});

import {
  clientDocumentTypesListQuerySchema,
  createClientDocumentTypeSchema,
  patchClientDocumentTypeSchema,
} from "../../../lib/client-document-types/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterClientDocumentType,
  MasterClientDocumentTypeList,
  MasterClientDocumentTypeOptions,
} from "../../responses/masters/client-document-types.js";

// Docs for src/routes/masters/client-document-types.ts — see docs/api/README.md.
const r = documentRouter("/masters/client-document-types");

r.get("/", {
  summary: "List client document types",
  description: "Paginated master list. `search` matches name, file-name prefix or id; `activeOnly=true` hides inactive rows.",
  query: clientDocumentTypesListQuerySchema,
  responses: { 200: MasterClientDocumentTypeList },
});

r.get("/options", {
  summary: "Active client document types",
  description: "All active client document types for select inputs, ordered by id.",
  responses: { 200: MasterClientDocumentTypeOptions },
});

r.post("/", {
  summary: "Create client document type",
  description: "The id is the next free integer and the file-name prefix is derived from it.",
  body: createClientDocumentTypeSchema,
  responses: {
    201: { description: "Created document type.", schema: MasterClientDocumentType },
    400: { description: "Invalid input, or a document type with this name already exists.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update client document type",
  description: "Rename and/or activate/deactivate. At least one field is required.",
  params: IdParam,
  body: patchClientDocumentTypeSchema,
  responses: {
    200: MasterClientDocumentType,
    400: {
      description: "Invalid id or input, or another document type already has this name.",
      schema: ValidationErrorBody,
    },
    404: { description: "Document type not found.", schema: ErrorBody },
  },
});

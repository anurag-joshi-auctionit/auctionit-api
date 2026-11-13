import { z } from "zod";
import {
  additionalFieldBodySchema,
  additionalFieldStatusSchema,
  auctionSettingsSchema,
  clientDocumentsListQuerySchema,
  clientDocumentUploadFieldsSchema,
  clientsListQuerySchema,
  companyInfoUpdateSchema,
  createClientSchema,
  mappedBiddersListQuerySchema,
  materialLocationBodySchema,
  plantLocationBodySchema,
} from "../../lib/clients/schemas.js";
import { entityOptionIdsQuerySchema, entityOptionsQuerySchema } from "../../lib/options-query.js";
import {
  createEntityUserSchema,
  entityUsersListQuerySchema,
  updateEntityUserSchema,
} from "../../lib/users/schemas.js";
import { BinaryFile, ErrorBody, IdParam, OkBody, OptionIdsResult, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  ClientAdditionalFieldList,
  ClientCounts,
  ClientDetailEnvelope,
  ClientDocumentEnvelope,
  ClientDocumentList,
  ClientDocumentTypes,
  ClientIdResult,
  ClientKamUsers,
  ClientList,
  ClientMappedBidderList,
  ClientNewId,
  ClientOptions,
  ClientPickerContext,
  ClientUserCreated,
  ClientUserCredentialsErrorBody,
  ClientUserList,
} from "../responses/clients.js";

// Docs for src/routes/clients.ts — see docs/api/README.md.
const r = documentRouter("/clients");

const clientNotFound = { description: "Client not found.", schema: ErrorBody };
/** Every `/:id` route answers 400 `{ error }` for a non-numeric id, besides Zod validation bodies. */
const bad = (description: string) => ({ description, schema: z.union([ValidationErrorBody, ErrorBody]) });
const badId = { description: "Invalid client id.", schema: ErrorBody };

// ---------------------------------------------------------------------------
// Directory, pickers and lookups
// ---------------------------------------------------------------------------

r.get("/", {
  summary: "List clients",
  description: "Paginated, filterable client list with counts for the status tabs. `dateFrom`/`dateTo` filter on `dateField` (`createdAt`).",
  query: clientsListQuerySchema,
  responses: { 200: ClientList },
});

r.get("/stats", {
  summary: "Client counts",
  description: "Total / active / inactive client counts.",
  responses: { 200: ClientCounts },
});

r.get("/options", {
  summary: "Client options for a picker",
  description:
    "Active clients for select inputs. Empty `q` returns up to `limit` (max 100); a search returns all matches. " +
    "Ids in `ids` (comma-separated) are always included.",
  query: entityOptionsQuerySchema,
  responses: { 200: ClientOptions },
});

r.get("/options/ids", {
  summary: "Client ids matching a search (select all)",
  query: entityOptionIdsQuerySchema,
  responses: { 200: OptionIdsResult },
});

r.get("/kam-users", {
  summary: "KAM users",
  description: "Active users with the `kam` role, for the plant-location KAM picker.",
  responses: { 200: ClientKamUsers },
});

r.get("/document-types", {
  summary: "Client document types",
  description: "Active client document types with their allowed extensions and size limits.",
  responses: { 200: ClientDocumentTypes },
});

r.get("/:id/picker-context", {
  summary: "Region / plant picker data",
  description: "Active plant locations of the client (and an always-empty `regions` list) for auction forms.",
  params: IdParam,
  responses: { 200: ClientPickerContext, 400: badId, 404: clientNotFound },
});

// ---------------------------------------------------------------------------
// Client CRUD
// ---------------------------------------------------------------------------

r.post("/", {
  summary: "Create client",
  description:
    "Creates the client with company info, service fee, optional auction settings, at least one plant location and " +
    "optional material locations in one request. An unknown `locationId` is stored as null.",
  body: createClientSchema,
  responses: {
    201: { description: "Created.", schema: ClientIdResult },
    400: { description: "Validation error.", schema: ValidationErrorBody },
  },
});

r.get("/:id", {
  summary: "Get client",
  description:
    "Full client record: company info, auction settings, plant and material locations, and `canEditAuctionSettings`. " +
    "`regions`, `contacts`, `notifications` and `users` are currently always empty.",
  params: IdParam,
  responses: { 200: ClientDetailEnvelope, 400: badId, 404: clientNotFound },
});

r.patch("/:id/company-info", {
  summary: "Update company info",
  description:
    "Replaces the company-info section and service fee (all fields required). `isActive` is optional and toggles the " +
    "client. An unknown `locationId` is stored as null.",
  params: IdParam,
  body: companyInfoUpdateSchema,
  responses: { 200: OkBody, 400: bad("Invalid client id or validation error."), 404: clientNotFound },
});

r.patch("/:id/auction-settings", {
  summary: "Update auction settings",
  description:
    "Replaces the auction prefix, service fee, last-bid extension (window/interval/count must be all 0 or all > 0; " +
    "`isLastBidExtension` is derived from them) and stagger settings (`staggerInterval` > 0 when `isStaggered`). " +
    "Rejected while any of the client's published auctions is live today (IST).",
  params: IdParam,
  body: auctionSettingsSchema,
  responses: {
    200: OkBody,
    400: bad("Invalid client id, validation error, or the client has a live auction (`{ error }`)."),
    404: clientNotFound,
  },
});

// ---------------------------------------------------------------------------
// Mapped bidders & documents
// ---------------------------------------------------------------------------

r.get("/:id/mapped-bidders", {
  summary: "Bidders mapped to the client's auctions",
  description: "Bidders actively mapped to at least one auction of this client, with auction count and latest auction date.",
  params: IdParam,
  query: mappedBiddersListQuerySchema,
  responses: { 200: ClientMappedBidderList, 400: bad("Invalid client id or query."), 404: clientNotFound },
});

r.get("/:id/documents/history", {
  summary: "Client document history",
  description: "Every uploaded version of every document type (paginated), with signed preview URLs.",
  params: IdParam,
  query: clientDocumentsListQuerySchema,
  responses: { 200: ClientDocumentList, 400: bad("Invalid client id or query."), 404: clientNotFound },
});

r.get("/:id/documents", {
  summary: "Current client documents",
  description: "The latest upload per document type (paginated), with signed preview URLs.",
  params: IdParam,
  query: clientDocumentsListQuerySchema,
  responses: { 200: ClientDocumentList, 400: bad("Invalid client id or query."), 404: clientNotFound },
});

r.put("/:id/documents", {
  summary: "Upload client document",
  description:
    "Uploads a new version of one document type (multipart field `file`, max 10 MB; the T&C type follows the auction " +
    "document rules). The file is stored in object storage and becomes the current document for that type; older " +
    "versions stay in the history.",
  params: IdParam,
  body: clientDocumentUploadFieldsSchema.extend({ file: BinaryFile }),
  responses: {
    200: ClientDocumentEnvelope,
    400: bad(
      "Invalid client id, missing/empty `file`, file too large (`fieldErrors.file`), disallowed extension, missing or unknown `documentTypeId`.",
    ),
    404: clientNotFound,
  },
});

// ---------------------------------------------------------------------------
// Additional fields (custom auction/lot fields)
// ---------------------------------------------------------------------------

const fieldParams = z.object({
  id: z.coerce.number().int().positive(),
  fieldId: z.coerce.number().int().positive(),
});
const fieldNotFound = { description: "Client or additional field not found.", schema: ErrorBody };

r.get("/:id/additional-fields", {
  summary: "List additional fields",
  description: "Custom auction/lot fields defined for the client, ordered by scope, display order and id.",
  params: IdParam,
  responses: { 200: ClientAdditionalFieldList, 400: badId, 404: clientNotFound },
});

r.post("/:id/additional-fields", {
  summary: "Create additional field",
  description: "Adds an active custom field. Labels are unique per client and scope (case-insensitive).",
  params: IdParam,
  body: additionalFieldBodySchema,
  responses: {
    201: { description: "Created.", schema: ClientNewId },
    400: bad("Invalid client id, validation error, or the label is already used (`fieldErrors.label`)."),
    404: clientNotFound,
  },
});

r.patch("/:id/additional-fields/:fieldId", {
  summary: "Update additional field",
  description:
    "Replaces label, scope, data type and display order. Once any auction/lot holds a value for the field, its scope " +
    "and data type can no longer change.",
  params: fieldParams,
  body: additionalFieldBodySchema,
  responses: {
    200: OkBody,
    400: bad("Invalid ids, validation error, duplicate label, or scope/data type locked (`fieldErrors.scope` / `fieldErrors.dataType`)."),
    404: fieldNotFound,
  },
});

r.patch("/:id/additional-fields/:fieldId/status", {
  summary: "Activate / deactivate additional field",
  params: fieldParams,
  body: additionalFieldStatusSchema,
  responses: { 200: OkBody, 400: bad("Invalid ids or validation error."), 404: fieldNotFound },
});

// ---------------------------------------------------------------------------
// Not migrated yet (always 501)
// ---------------------------------------------------------------------------

const notMigrated = { 501: { description: "Not migrated to the new API yet.", schema: ErrorBody } };

r.post("/:id/regions", {
  summary: "Create region (not implemented)",
  description: "Placeholder: always responds 501.",
  params: IdParam,
  responses: notMigrated,
  deprecated: true,
});

r.patch("/:id/regions/:regionId", {
  summary: "Update region (not implemented)",
  description: "Placeholder: always responds 501.",
  responses: notMigrated,
  deprecated: true,
});

r.post("/:id/contacts", {
  summary: "Create contact (not implemented)",
  description: "Placeholder: always responds 501.",
  params: IdParam,
  responses: notMigrated,
  deprecated: true,
});

// ---------------------------------------------------------------------------
// Client portal users
// ---------------------------------------------------------------------------

const userParams = z.object({
  id: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});
const userNotFound = { description: "Client not found, or the user is not linked to this client.", schema: ErrorBody };

r.get("/:id/users", {
  summary: "List client portal users",
  params: IdParam,
  query: entityUsersListQuerySchema,
  responses: { 200: ClientUserList, 400: bad("Invalid client id or query."), 404: clientNotFound },
});

r.post("/:id/users", {
  summary: "Create client portal user",
  description:
    "Creates a login with the `client` role linked to this client. The password is an unusable random value and " +
    "**no email is sent** — use `POST /clients/{id}/users/{userId}/reset-password` to email credentials.",
  params: IdParam,
  body: createEntityUserSchema,
  responses: {
    201: { description: "Created.", schema: ClientUserCreated },
    400: bad("Invalid client id or validation error."),
    404: clientNotFound,
    409: { description: "Username already taken (`fieldErrors.userLoginName`).", schema: ValidationErrorBody },
  },
});

r.patch("/:id/users/:userId", {
  summary: "Update client portal user",
  description: "Replaces profile fields; `isActive` sets both the user and its client membership.",
  params: userParams,
  body: updateEntityUserSchema,
  responses: { 200: OkBody, 400: bad("Invalid ids or validation error."), 404: userNotFound },
});

r.post("/:id/users/:userId/reset-password", {
  summary: "Reset client user password",
  description:
    "Generates a temporary password, ends the user's session and **emails** the credentials. The user must change it after logging in.",
  params: userParams,
  responses: {
    200: OkBody,
    400: {
      description: "Invalid ids, or `OTP_MISSING_EMAIL` / `OTP_DELIVERY_FAILED` (credentials email could not be sent).",
      schema: z.union([ErrorBody, ClientUserCredentialsErrorBody]),
    },
    404: userNotFound,
  },
});

// ---------------------------------------------------------------------------
// Plant & material locations
// ---------------------------------------------------------------------------

const locationParams = z.object({
  id: z.coerce.number().int().positive(),
  locationId: z.coerce.number().int().positive(),
});

r.post("/:id/plant-locations", {
  summary: "Add plant location",
  description: "`kamId` must be an active KAM user. An unknown `locationId` is stored as null.",
  params: IdParam,
  body: plantLocationBodySchema,
  responses: {
    201: { description: "Created.", schema: ClientNewId },
    400: bad("Invalid client id, validation error, or `kamId` is not an active KAM user (`fieldErrors.kamId`)."),
    404: clientNotFound,
  },
});

r.patch("/:id/plant-locations/:locationId", {
  summary: "Update plant location",
  description:
    "Partial update (every field of the create body is optional). A client must keep at least one active plant " +
    "location, so deactivating the last one is rejected.",
  params: locationParams,
  body: plantLocationBodySchema.partial(),
  responses: {
    200: OkBody,
    400: bad(
      "Invalid ids, validation error, `kamId` not an active KAM user, or deactivating the last active plant location (`fieldErrors.isActive`).",
    ),
    404: { description: "Client or plant location not found.", schema: ErrorBody },
  },
});

r.post("/:id/material-locations", {
  summary: "Add material location",
  description: "An unknown `locationId` is stored as null.",
  params: IdParam,
  body: materialLocationBodySchema,
  responses: { 201: { description: "Created.", schema: ClientNewId }, 400: bad("Invalid client id or validation error."), 404: clientNotFound },
});

r.patch("/:id/material-locations/:locationId", {
  summary: "Update material location",
  description: "Partial update (every field of the create body is optional).",
  params: locationParams,
  body: materialLocationBodySchema.partial(),
  responses: {
    200: OkBody,
    400: bad("Invalid ids or validation error."),
    404: { description: "Client or material location not found.", schema: ErrorBody },
  },
});

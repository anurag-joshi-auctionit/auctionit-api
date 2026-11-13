import { z, type AnyZodObject } from "zod";
import {
  bidderBankAccountBodySchema,
  bidderBlocksListQuerySchema,
  bidderDocumentsListQuerySchema,
  bidderDocumentUploadFieldsSchema,
  bidderExemptionsListQuerySchema,
  bidderInfoSchema,
  bidderStatusSchema,
  bidderSubscriptionBodySchema,
  biddersListQuerySchema,
  blockBidderBodySchema,
  blockBidderCreateBodySchema,
  blockedBiddersListQuerySchema,
  createBidderSchema,
  exemptBidderBodySchema,
  exemptBidderCreateBodySchema,
  exemptedBiddersListQuerySchema,
} from "../../lib/bidders/schemas.js";
import { entityOptionIdsQuerySchema, entityOptionsQuerySchema } from "../../lib/options-query.js";
import {
  createEntityUserSchema,
  entityUsersListQuerySchema,
  updateEntityUserSchema,
} from "../../lib/users/schemas.js";
import { BinaryFile, ErrorBody, IdParam, OkBody, OptionIdsResult, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  BidderBankAccountNullableResponse,
  BidderBankAccountResponse,
  BidderBlockList,
  BidderCounts,
  BidderCreated,
  BidderDetailResponse,
  BidderDocumentList,
  BidderDocumentTypes,
  BidderDocumentUploaded,
  BidderExemptionList,
  BidderList,
  BidderOptions,
  BidderPaymentTypes,
  BidderStatusResult,
  BidderSubscriptionList,
  BidderSubscriptionQuote,
  BidderSubscriptionRecorded,
  BidderUserCreated,
  BidderUserErrorBody,
  BidderUserList,
  BlockedBidderList,
  ExemptedBidderList,
} from "../responses/bidders.js";

// Docs for src/routes/bidders.ts — see docs/api/README.md.
const r = documentRouter("/bidders");

const clientFilter = {
  clientId: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Exclude bidders currently blocked for this client."),
};

// bidderSubscriptionBodySchema is a ZodEffects (superRefine) over an object whose `remarks` field is a
// union including z.undefined(), which zod-to-openapi cannot render. Document the inner object with
// `remarks` re-expressed; see subscriptionPaymentFieldsObjectSchema in lib/subscriptions/schemas.ts.
const subscriptionPaymentBody = (bidderSubscriptionBodySchema._def.schema as AnyZodObject).extend({
  remarks: z.string().max(2000).nullable().optional().describe("Blank is stored as null."),
});

const bidderNotFound = { description: "Bidder not found.", schema: ErrorBody };
const invalidId = { description: "Invalid bidder id.", schema: ErrorBody };
const UserIdParams = z.object({
  id: z.coerce.number().int().positive().openapi({ param: { name: "id", in: "path" } }),
  userId: z.coerce.number().int().positive().openapi({ param: { name: "userId", in: "path" } }),
});
const ClientIdParams = z.object({
  id: z.coerce.number().int().positive().openapi({ param: { name: "id", in: "path" } }),
  clientId: z.coerce.number().int().positive().openapi({ param: { name: "clientId", in: "path" } }),
});

// ---- Pickers ----

r.get("/options", {
  summary: "Bidder options for a picker",
  description:
    "Active, verified bidders for select inputs, matched on company name or id. Empty `q` returns up to " +
    "`limit` (max 100); a search returns all matches. Ids in `ids` are always included (if active and verified).",
  query: entityOptionsQuerySchema.extend(clientFilter),
  responses: { 200: BidderOptions },
});

r.get("/options/ids", {
  summary: "Bidder ids matching a search (select all)",
  description: "Active, verified bidders only.",
  query: entityOptionIdsQuerySchema.extend(clientFilter),
  responses: { 200: OptionIdsResult },
});

// ---- Collection ----

r.get("/", {
  summary: "List bidders",
  description: "Paginated, filterable bidder list with global counts for the status tabs.",
  query: biddersListQuerySchema,
  responses: { 200: BidderList },
});

r.post("/", {
  summary: "Create bidder",
  description:
    "Creates the bidder (inactive and unverified unless set) together with its single login user. " +
    "No credentials are emailed; use the user's reset-password endpoint to send them. " +
    "If the user cannot be created the bidder row is rolled back.",
  body: createBidderSchema,
  responses: {
    201: { description: "Created bidder and user ids.", schema: BidderCreated },
    400: { description: "Invalid input, or the location does not exist.", schema: ValidationErrorBody },
    409: { description: "The login name is already taken.", schema: ValidationErrorBody },
  },
});

r.get("/stats", {
  summary: "Bidder counts",
  description: "Total / active / inactive / unverified bidders and bidders created in the last 30 days.",
  responses: { 200: BidderCounts },
});

r.post("/:id/approve", {
  summary: "Approve bidder",
  description: "Marks a pending bidder verified.",
  params: IdParam,
  responses: { 200: OkBody, 400: invalidId, 404: bidderNotFound },
});

r.post("/:id/reject", {
  summary: "Reject bidder",
  description:
    "Deactivates and unverifies the bidder, deactivates its login user, and detaches it from lots that " +
    "have not started yet (releasing any EMD held for them).",
  params: IdParam,
  responses: { 200: OkBody, 400: invalidId, 404: bidderNotFound },
});

r.get("/payment-types", {
  summary: "Active payment types",
  description: "Payment modes for the subscription payment form.",
  responses: { 200: BidderPaymentTypes },
});

r.get("/blocked", {
  summary: "List currently blocked bidders",
  description: "One row per bidder–client pair whose latest block log is a block.",
  query: blockedBiddersListQuerySchema,
  responses: { 200: BlockedBidderList },
});

r.post("/blocks", {
  summary: "Block bidder for a client",
  description: "Picker flow: bidder id in the body. Appends a block log entry.",
  body: blockBidderCreateBodySchema,
  responses: {
    200: OkBody,
    400: { description: "Invalid input, or the client does not exist.", schema: ValidationErrorBody },
    404: bidderNotFound,
    409: { description: "The bidder is already blocked for this client.", schema: ValidationErrorBody },
  },
});

r.get("/exempted", {
  summary: "List currently exempted bidders",
  description: "One row per bidder–client pair whose latest exemption log is an exemption.",
  query: exemptedBiddersListQuerySchema,
  responses: { 200: ExemptedBidderList },
});

r.post("/exemptions", {
  summary: "Exempt bidder for a client",
  description: "Picker flow: bidder id in the body. Appends an exemption log entry.",
  body: exemptBidderCreateBodySchema,
  responses: {
    200: OkBody,
    400: { description: "Invalid input, or the client does not exist.", schema: ValidationErrorBody },
    404: bidderNotFound,
    409: { description: "The bidder is already exempted for this client.", schema: ValidationErrorBody },
  },
});

r.get("/document-types", {
  summary: "Bidder document types",
  description:
    "Active document types that can be uploaded through the Documents tab (the cancelled cheque is excluded; " +
    "it is uploaded with the bank account) and the allowed file extensions.",
  responses: { 200: BidderDocumentTypes },
});

// ---- Single bidder ----

r.get("/:id", {
  summary: "Get bidder",
  params: IdParam,
  responses: { 200: BidderDetailResponse, 400: invalidId, 404: bidderNotFound },
});

r.patch("/:id/info", {
  summary: "Update bidder profile",
  description: "Replaces the company profile fields. Country/state/city are derived from `locationId`.",
  params: IdParam,
  body: bidderInfoSchema,
  responses: {
    200: OkBody,
    400: { description: "Invalid input, or the location does not exist.", schema: ValidationErrorBody },
    404: bidderNotFound,
  },
});

r.patch("/:id/status", {
  summary: "Set bidder active / verified",
  description:
    "When `isVerified` is false the bidder is also removed from lots that have not started yet and EMD held " +
    "for those auctions is released (re-run on every save while unverified, so a failed release can be retried). " +
    "Live lots are left in place.",
  params: IdParam,
  body: bidderStatusSchema,
  responses: { 200: BidderStatusResult, 404: bidderNotFound },
});

r.get("/:id/documents/history", {
  summary: "List bidder document history",
  description: "Every active document upload for the bidder, all versions (default sort: newest first).",
  params: IdParam,
  query: bidderDocumentsListQuerySchema,
  responses: { 200: BidderDocumentList, 404: bidderNotFound },
});

r.get("/:id/documents", {
  summary: "List bidder documents",
  description: "Latest upload per document type (default sort: newest first).",
  params: IdParam,
  query: bidderDocumentsListQuerySchema,
  responses: { 200: BidderDocumentList, 404: bidderNotFound },
});

r.put("/:id/documents", {
  summary: "Upload bidder document",
  description:
    "Uploads a new version of one document type. Max 10 MB; allowed extensions are listed by " +
    "`GET /bidders/document-types`. The cancelled-cheque type is rejected here.",
  params: IdParam,
  body: bidderDocumentUploadFieldsSchema.extend({ file: BinaryFile }),
  responses: {
    200: BidderDocumentUploaded,
    400: {
      description:
        "Invalid input; file missing, empty, too large or of a disallowed type; or the document type does not exist.",
      schema: ErrorBody,
    },
    404: bidderNotFound,
  },
});

r.get("/:id/bank-account", {
  summary: "Get bidder bank account",
  description: "`bankAccount` is null when the bidder has no bank details on file.",
  params: IdParam,
  responses: { 200: BidderBankAccountNullableResponse, 404: bidderNotFound },
});

r.put("/:id/bank-account", {
  summary: "Create or update bidder bank account",
  description:
    "Admin edit of the live bank details. A new row starts unverified; an existing row keeps its verification " +
    "state. If `chequeBase64` is given (max 10 MB decoded) it is stored as the bidder's cancelled-cheque document.",
  params: IdParam,
  body: bidderBankAccountBodySchema,
  responses: {
    200: BidderBankAccountResponse,
    400: { description: "Invalid input, or the cheque is empty or too large.", schema: ValidationErrorBody },
    404: bidderNotFound,
  },
});

r.post("/:id/bank-account/verify", {
  summary: "Verify bidder bank account",
  params: IdParam,
  responses: {
    200: BidderBankAccountResponse,
    404: { description: "Bidder or bank account not found.", schema: ErrorBody },
    409: { description: "The bank account is already verified.", schema: ErrorBody },
  },
});

r.post("/:id/bank-account/reject", {
  summary: "Reject bidder bank account",
  description: "Records the review and leaves the account unverified. A verified account cannot be rejected.",
  params: IdParam,
  responses: {
    200: BidderBankAccountResponse,
    404: { description: "Bidder or bank account not found.", schema: ErrorBody },
    409: { description: "The bank account is already verified.", schema: ErrorBody },
  },
});

// ---- Users ----

r.get("/:id/users", {
  summary: "List bidder users",
  params: IdParam,
  query: entityUsersListQuerySchema,
  responses: { 200: BidderUserList, 404: bidderNotFound },
});

r.post("/:id/users", {
  summary: "Create bidder user",
  description: "A bidder can have only one login user. No credentials are emailed; use reset-password to send them.",
  params: IdParam,
  body: createEntityUserSchema,
  responses: {
    201: { description: "Created user id.", schema: BidderUserCreated },
    404: bidderNotFound,
    409: {
      description: "The login name is taken (`fieldErrors.userLoginName`), or the bidder already has a user.",
      schema: ValidationErrorBody,
    },
  },
});

r.patch("/:id/users/:userId", {
  summary: "Update bidder user",
  params: UserIdParams,
  body: updateEntityUserSchema,
  responses: {
    200: OkBody,
    400: { description: "Invalid ids or input.", schema: ValidationErrorBody },
    404: { description: "User not linked to this bidder.", schema: ErrorBody },
  },
});

r.post("/:id/users/:userId/reset-password", {
  summary: "Reset bidder user password",
  description: "Issues a new temporary password and emails it to the user.",
  params: UserIdParams,
  responses: {
    200: OkBody,
    400: {
      description: "Invalid ids, the user has no email address, or the email could not be sent.",
      schema: BidderUserErrorBody,
    },
    404: { description: "User not linked to this bidder.", schema: ErrorBody },
  },
});

// ---- Blocks / exemptions ----

r.get("/:id/blocks", {
  summary: "List bidder's client blocks",
  description: "Clients the bidder is currently blocked for.",
  params: IdParam,
  query: bidderBlocksListQuerySchema,
  responses: { 200: BidderBlockList, 404: bidderNotFound },
});

r.post("/:id/blocks", {
  summary: "Block bidder for a client",
  description: "Appends a block log entry for this bidder and client.",
  params: IdParam,
  body: blockBidderBodySchema,
  responses: {
    200: OkBody,
    400: { description: "Invalid input, or the client does not exist.", schema: ValidationErrorBody },
    404: bidderNotFound,
    409: { description: "The bidder is already blocked for this client.", schema: ValidationErrorBody },
  },
});

r.post("/:id/blocks/:clientId/unblock", {
  summary: "Unblock bidder for a client",
  description: "Appends an unblock log entry.",
  params: ClientIdParams,
  responses: {
    200: OkBody,
    400: { description: "Invalid bidder or client id.", schema: ErrorBody },
    404: bidderNotFound,
    409: { description: "The bidder is not blocked for this client.", schema: ErrorBody },
  },
});

r.get("/:id/exemptions", {
  summary: "List bidder's client exemptions",
  description: "Clients the bidder is currently exempted for.",
  params: IdParam,
  query: bidderExemptionsListQuerySchema,
  responses: { 200: BidderExemptionList, 404: bidderNotFound },
});

r.post("/:id/exemptions", {
  summary: "Exempt bidder for a client",
  description: "Appends an exemption log entry for this bidder and client.",
  params: IdParam,
  body: exemptBidderBodySchema,
  responses: {
    200: OkBody,
    400: { description: "Invalid input, or the client does not exist.", schema: ValidationErrorBody },
    404: bidderNotFound,
    409: { description: "The bidder is already exempted for this client.", schema: ValidationErrorBody },
  },
});

r.post("/:id/exemptions/:clientId/revoke", {
  summary: "Revoke bidder exemption for a client",
  description: "Appends a revoke log entry.",
  params: ClientIdParams,
  responses: {
    200: OkBody,
    400: { description: "Invalid bidder or client id.", schema: ErrorBody },
    404: bidderNotFound,
    409: { description: "The bidder is not exempted for this client.", schema: ErrorBody },
  },
});

// ---- Subscriptions ----

r.get("/:id/subscriptions", {
  summary: "List bidder subscriptions",
  description: "All subscription payments of the bidder (unpaginated, `pageSize` is 0) with its current subscription status.",
  params: IdParam,
  responses: { 200: BidderSubscriptionList, 400: invalidId },
});

r.get("/:id/subscriptions/quote", {
  summary: "Quote a subscription plan",
  description:
    "Autofill for the add-payment form: plan amount split into price and GST, and the validity period. " +
    "The period starts on the first of `fromDate`'s month (default: current IST month).",
  params: IdParam,
  // Read directly from req.query in src/routes/bidders.ts (no schema).
  query: z.object({
    typeId: z.coerce.number().int().positive().describe("Subscription type (plan) id."),
    fromDate: z.string().optional().describe("YYYY-MM-DD; only the month is used."),
  }),
  responses: {
    200: BidderSubscriptionQuote,
    400: { description: "Invalid bidder or subscription type id.", schema: ErrorBody },
    404: { description: "Subscription type not found.", schema: ErrorBody },
  },
});

r.post("/:id/subscriptions", {
  summary: "Record subscription payment",
  description:
    "Records an offline subscription payment and queues its invoice (`requested`). The stored amount is always " +
    "the plan total and `toDate` is derived from the plan length; the client values are ignored. Also updates the " +
    "bidder's validity dates.",
  params: IdParam,
  body: subscriptionPaymentBody,
  responses: {
    201: { description: "Payment recorded.", schema: BidderSubscriptionRecorded },
    400: {
      description: "Invalid input, the period starts before the payment month, or the transaction id is already used.",
      schema: ValidationErrorBody,
    },
    404: { description: "Subscription type not found.", schema: ErrorBody },
  },
});

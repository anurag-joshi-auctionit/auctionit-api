import { z } from "zod";
import { BiddersValidationMessages } from "@auctionit/messages/bidders";
import { bidderBankAccountBodySchema } from "../../lib/bidders/schemas.js";
import { BinaryFile, ErrorBody, IdParam, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  BankAccountHistory,
  BankAccountIssuesErrorBody,
  BankAccountPortalSummary,
  BankAccountRequestList,
  BankAccountRequestResult,
} from "../responses/bank-account.js";

// Docs for src/routes/bank-account.ts — see docs/api/README.md.
const r = documentRouter("/bank-account");

// Recreated from src/routes/bank-account.ts (`listQuerySchema`).
const listQuerySchema = z.object({
  decision: z.enum(["pending", "accepted", "rejected"]).optional().default("pending"),
  search: z.string().trim().optional().describe("Matches company name, or exact bidder id when numeric."),
  bidderId: z.coerce.number().int().positive().optional(),
  dateField: z.enum(["requestedAt", "reviewedAt"]).optional(),
  dateFrom: z.string().trim().optional().describe("YYYY-MM-DD; ignored unless `dateField` is set."),
  dateTo: z.string().trim().optional().describe("YYYY-MM-DD, inclusive."),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
});

// Recreated from src/routes/bank-account.ts (`rejectBodySchema`).
const rejectBodySchema = z.object({
  remark: z.string().trim().max(500, BiddersValidationMessages.REVIEW_REMARK_MAX).optional().nullable(),
});

// Multipart body of POST /logs: bidderBankAccountBodySchema without chequeBase64, plus the `cheque` file.
const submitBodySchema = bidderBankAccountBodySchema.omit({ chequeBase64: true }).extend({
  cheque: BinaryFile.openapi({
    description: "Cancelled cheque image/PDF (max 10 MB; jpg, jpeg, png, webp, pdf, doc, docx, xls, xlsx).",
  }),
});

const notPending = { description: "The request has already been accepted or rejected.", schema: ErrorBody };
const requestNotFound = { description: "Update request not found.", schema: ErrorBody };

// ---- Portal (bidder) ----

r.get("/me", {
  summary: "Get my bank details",
  description: "The signed-in bidder's live bank details plus their pending update request, if any.",
  responses: {
    200: BankAccountPortalSummary,
    403: { description: "The session is not linked to a bidder.", schema: ErrorBody },
    404: { description: "The linked bidder no longer exists.", schema: ErrorBody },
  },
});

r.get("/me/logs", {
  summary: "List my bank update requests",
  description: "All of the signed-in bidder's bank update requests, newest first (not paginated).",
  responses: {
    200: BankAccountHistory,
    403: { description: "The session is not linked to a bidder.", schema: ErrorBody },
    404: { description: "The linked bidder no longer exists.", schema: ErrorBody },
  },
});

r.post("/logs", {
  summary: "Submit bank update request",
  description:
    "Bidder requests a change of bank details with a cancelled cheque. The request stays pending until an " +
    "admin accepts or rejects it. Submitting marks the current live bank details and the bidder unverified (releasing them from unstarted lots), and emails the " +
    "bidder an acknowledgement. Only one pending request is allowed at a time.",
  body: submitBodySchema,
  responses: {
    201: { description: "Request submitted.", schema: BankAccountRequestResult },
    400: {
      description: "Invalid fields, or the cheque is missing, empty, too large or of a disallowed type.",
      schema: ValidationErrorBody,
    },
    403: { description: "The session is not linked to a bidder.", schema: ErrorBody },
    404: { description: "Bidder not found.", schema: ErrorBody },
    409: { description: "The bidder already has a pending update request.", schema: ErrorBody },
  },
});

// ---- Admin ----

r.get("/logs", {
  summary: "List bank update requests",
  description: "Paginated update requests for one decision tab (default `pending`), newest first, with counts per decision.",
  query: listQuerySchema,
  responses: {
    200: BankAccountRequestList,
    400: { description: "Invalid query.", schema: BankAccountIssuesErrorBody },
  },
});

r.post("/logs/:id/accept", {
  summary: "Accept bank update request",
  description:
    "Copies the requested details onto the bidder's live bank account and marks it verified, moves the " +
    "cheque to the live document store (logged as the bidder's cancelled-cheque document), and emails the bidder.",
  params: IdParam,
  responses: {
    200: { description: "Accepted request.", schema: BankAccountRequestResult },
    400: { description: "Invalid request id.", schema: ErrorBody },
    404: requestNotFound,
    409: notPending,
  },
});

r.post("/logs/:id/reject", {
  summary: "Reject bank update request",
  description:
    "Marks the request rejected with an optional remark and emails the bidder. The live bank details are left " +
    "as they are (still unverified from the submission).",
  params: IdParam,
  body: rejectBodySchema,
  responses: {
    200: { description: "Rejected request.", schema: BankAccountRequestResult },
    400: { description: "Invalid request id or body.", schema: BankAccountIssuesErrorBody },
    404: requestNotFound,
    409: notPending,
  },
});

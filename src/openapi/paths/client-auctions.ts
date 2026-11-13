import { z } from "zod";
import { closedDateRangeQuerySchema } from "../../lib/closed-auction-date-range.js";
import { ErrorBody, IdParam, OkBody, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  ClientAuctionApprovalLots,
  ClientAuctionClosedList,
  ClientAuctionDetail,
  ClientAuctionLotsResponse,
  ClientAuctionNotifyResult,
  ClientAuctionParticipantList,
  ClientAuctionScheduledList,
} from "../responses/client-auctions.js";

// Docs for src/routes/client-auctions.ts — see docs/api/README.md.
const r = documentRouter("/client/auctions");

// Recreated from src/routes/client-auctions.ts (schemas are defined inline there).
const lotIdsBodySchema = z.object({
  lotIds: z.array(z.number().int().positive()).optional(),
  all: z.boolean().optional().describe("Apply to every lot of the auction (takes precedence over `lotIds`)."),
});

const saveApprovalsBodySchema = z.object({
  entries: z
    .array(
      z.object({
        lotId: z.number().int().positive(),
        isApproved: z
          .boolean()
          .nullable()
          .optional()
          .describe("`true` approve, `false` reject, `null` reset to pending, omitted = leave unchanged."),
        remark: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1),
});

const notifyWinnersBodySchema = z.object({
  lotIds: z.array(z.number().int().positive()).min(1),
});

const badId = { description: "Invalid auction id.", schema: ErrorBody };
const forbidden = { description: "The auction belongs to a client the user is not linked to.", schema: ErrorBody };
const closedNotFound = { description: "Closed auction not found.", schema: ErrorBody };
const decisionErrors = {
  400: {
    description:
      "Invalid input, or the auction is not closed, a lot has no winning bid, or a lot's decision can no longer change.",
    schema: ValidationErrorBody,
  },
  403: forbidden,
  404: closedNotFound,
};

r.get("/today", {
  summary: "Today's auctions for my companies",
  description: "Published auctions dated today (IST) for the clients linked to the user, still live or upcoming.",
  responses: { 200: ClientAuctionScheduledList },
});

r.get("/future", {
  summary: "Future auctions for my companies",
  description: "Published auctions dated after today (IST) for the clients linked to the user.",
  responses: { 200: ClientAuctionScheduledList },
});

r.get("/closed", {
  summary: "Closed auctions for my companies",
  description: "Closed auctions with lot / approved-lot counts. `from` and `to` (YYYY-MM-DD) must be sent together.",
  query: closedDateRangeQuerySchema,
  responses: { 200: ClientAuctionClosedList },
});

r.get("/:id/approval-lots", {
  summary: "Lots awaiting approval",
  description: "Closed auction's lots with winner, taxes and current approval state, for the client approval screen.",
  params: IdParam,
  responses: { 200: ClientAuctionApprovalLots, 400: badId, 403: forbidden, 404: closedNotFound },
});

r.post("/:id/save-approvals", {
  summary: "Save lot approval decisions",
  description:
    "Per-lot approve / reject / reset with optional remark. Rejected lots release their EMD blocks; lot " +
    "confirmation PDFs are regenerated for affected winners.",
  params: IdParam,
  body: saveApprovalsBodySchema,
  responses: { 200: OkBody, ...decisionErrors },
});

r.post("/:id/approve-lots", {
  summary: "Approve lots",
  description: "Approves the given lots (or `all`). Every lot must have a winning bid.",
  params: IdParam,
  body: lotIdsBodySchema,
  responses: { 200: OkBody, ...decisionErrors },
});

r.post("/:id/reject-lots", {
  summary: "Reject lots",
  description: "Rejects the given lots (or `all`) and releases the winners' EMD blocks for them.",
  params: IdParam,
  body: lotIdsBodySchema,
  responses: { 200: OkBody, ...decisionErrors },
});

r.post("/:id/notify-winners", {
  summary: "Email lot confirmations to winners",
  description: "Sends lot confirmation emails to the winners of the given lots of a closed auction.",
  params: IdParam,
  body: notifyWinnersBodySchema,
  responses: {
    200: ClientAuctionNotifyResult,
    400: { description: "Invalid input, or the auction is not closed.", schema: ValidationErrorBody },
    403: forbidden,
    404: closedNotFound,
  },
});

r.get("/:id", {
  summary: "Auction detail for the client portal",
  description:
    "Header plus a body chosen by state: closed lots, upcoming lot schedule, or just the header when live.",
  params: IdParam,
  responses: {
    200: ClientAuctionDetail,
    400: badId,
    404: { description: "Auction not found, not published/closed, or not linked to the user.", schema: ErrorBody },
  },
});

r.get("/:id/participants", {
  summary: "Auction participants",
  description: "Registered bidders with login id, logged-in state and T&C acceptance.",
  params: IdParam,
  responses: { 200: ClientAuctionParticipantList, 400: badId, 403: forbidden },
});

r.get("/:id/lots", {
  summary: "Auction lots for the client portal",
  description:
    "`bucket=closed` returns a closed auction's lots with winners and bid counts; otherwise a published auction's " +
    "lot schedule (no winner or bidder identity).",
  params: IdParam,
  query: z.object({
    bucket: z.enum(["closed"]).optional().describe("`closed` for a closed auction; omit for a published one."),
  }),
  responses: {
    200: ClientAuctionLotsResponse,
    400: badId,
    404: { description: "Auction not found in the requested bucket or not linked to the user.", schema: ErrorBody },
  },
});

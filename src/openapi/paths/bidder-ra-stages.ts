import { ErrorBody, OkBody } from "../common.js";
import { documentRouter } from "../define.js";
import { z } from "../zod.js";
import {
  BidderRaStageDetail,
  BidderRaStageInvitationList,
  RaStageWindowList,
} from "../responses/bidder-ra-stages.js";

// Docs for src/routes/bidder-ra-stages.ts — see docs/api/README.md.
const r = documentRouter("/bidder-ra-stages");

const AuctionIdParam = z.object({
  auctionId: z.coerce.number().int().positive().openapi({ example: 1 }),
});
const AuctionIdStageKeyParam = AuctionIdParam.extend({
  stageKey: z.enum(["rfi", "rfp", "rfq"]),
});

r.get("/my-stages", {
  summary: "List all RA stage windows across auctions",
  description:
    "Returns every RA stage the bidder is invited to or shortlisted into, across all published auctions.",
  responses: { 200: RaStageWindowList },
});

r.get("/auctions/:auctionId", {
  summary: "List my RA Stage invitations for an auction",
  params: AuctionIdParam,
  responses: { 200: BidderRaStageInvitationList },
});

r.get("/auctions/:auctionId/:stageKey", {
  summary: "Get my stage questions and response",
  params: AuctionIdStageKeyParam,
  responses: {
    200: BidderRaStageDetail,
    400: { description: "Not invited to this stage.", schema: ErrorBody },
  },
});

r.post("/auctions/:auctionId/:stageKey/save-draft", {
  summary: "Save a draft response for a stage",
  description:
    "multipart/form-data: same shape as /submit but no required-field validation. Sets status to 'draft' and persists answers. Answers can be updated until the stage closes or the response is submitted.",
  bodyContentType: "multipart/form-data",
  params: AuctionIdStageKeyParam,
  body: z.object({
    answers: z.string().openapi({ description: "JSON-encoded Record<questionId, string | string[]>." }),
  }),
  responses: {
    200: OkBody,
    400: {
      description: "Not invited, already submitted, or stage not open.",
      schema: ErrorBody,
    },
  },
});

r.post("/auctions/:auctionId/:stageKey/submit", {
  summary: "Submit my stage response",
  description:
    "multipart/form-data: a JSON-encoded `answers` field (Record<questionId, string | string[]>) plus one `file_<questionId>` file field per file-upload question.",
  bodyContentType: "multipart/form-data",
  params: AuctionIdStageKeyParam,
  body: z.object({
    answers: z.string().openapi({ description: "JSON-encoded Record<questionId, string | string[]>." }),
  }),
  responses: {
    200: OkBody,
    400: {
      description: "Not invited, already submitted, stage not open, or a required answer is missing.",
      schema: ErrorBody,
    },
  },
});

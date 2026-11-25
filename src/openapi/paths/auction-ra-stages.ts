import {
  invitableBiddersQuerySchema,
  inviteBiddersSchema,
  saveStageSetupSchema,
  saveStagesConfigSchema,
  setStageDecisionSchema,
} from "../../lib/auction-ra-stages/schemas.js";
import { ErrorBody, OkBody, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import { z } from "../zod.js";
import {
  ActiveRaAuctionList,
  AuctionRaStageInvitableBidderList,
  AuctionRaStageInviteFilterOptions,
  AuctionRaStageInvitedBidderList,
  AuctionRaStageResponseDetail,
  AuctionRaStageResponseRowList,
  AuctionRaStages,
} from "../responses/auction-ra-stages.js";

// Docs for src/routes/auction-ra-stages.ts — see docs/api/README.md.
const r = documentRouter("/auctions");

const AuctionIdParam = z.object({
  auctionId: z.coerce.number().int().positive().openapi({ example: 1 }),
});
const AuctionIdStageKeyParam = AuctionIdParam.extend({
  stageKey: z.enum(["rfi", "rfp", "rfq"]),
});
const AuctionIdStageKeyBidderIdParam = AuctionIdStageKeyParam.extend({
  bidderId: z.coerce.number().int().positive(),
});
const AuctionIdBidderIdParam = AuctionIdParam.extend({
  bidderId: z.coerce.number().int().positive(),
});

r.get("/ra-stages/active-auctions", {
  summary: "List active RA auctions",
  description: "Returns all published, active reverse auctions that have at least one enabled RA stage.",
  responses: {
    200: ActiveRaAuctionList,
  },
});

r.get("/:auctionId/ra-stages", {
  summary: "Get RA Stages",
  description:
    "Returns the auction's rfi/rfp/rfq stage config, lazily creating the three default rows the first time this is called. Only valid for reverse auctions.",
  params: AuctionIdParam,
  responses: {
    200: AuctionRaStages,
    400: { description: "Auction not found, or not a reverse auction.", schema: ErrorBody },
  },
});

r.put("/:auctionId/ra-stages/config", {
  summary: "Enable/disable RA Stages",
  description:
    "Sets which of rfi/rfp/rfq are enabled for the auction. A stage already published or closed is left untouched.",
  params: AuctionIdParam,
  body: saveStagesConfigSchema,
  responses: {
    200: AuctionRaStages,
    400: { description: "Invalid input, or auction is not a reverse auction.", schema: ValidationErrorBody },
  },
});

r.put("/:auctionId/ra-stages/:stageKey", {
  summary: "Save one stage's setup",
  description:
    "Saves a stage's due-diligence questions and start/end dates. Only allowed while the stage is still draft — status becomes published, then closed, automatically from these dates. There is no manual open/close/reopen action.",
  params: AuctionIdStageKeyParam,
  body: saveStageSetupSchema,
  responses: {
    200: AuctionRaStages,
    400: {
      description: "Invalid input, the stage has already started, or the dates fail validation.",
      schema: ValidationErrorBody,
    },
  },
});

r.get("/:auctionId/ra-stages/invitable-bidders", {
  summary: "List bidders eligible to invite into RA Stages",
  description:
    "Active, verified, non-blocked bidders not already invited to this auction, optionally filtered by material or location.",
  params: AuctionIdParam,
  query: invitableBiddersQuerySchema,
  responses: { 200: AuctionRaStageInvitableBidderList },
});

r.get("/:auctionId/ra-stages/invite-filter-options", {
  summary: "Filter options for the invite dialog",
  description: "Material and location option lists derived from the current pool of invitable bidders.",
  params: AuctionIdParam,
  responses: { 200: AuctionRaStageInviteFilterOptions },
});

r.get("/:auctionId/ra-stages/invited-bidders", {
  summary: "List bidders invited into RA Stages",
  params: AuctionIdParam,
  responses: { 200: AuctionRaStageInvitedBidderList },
});

r.post("/:auctionId/ra-stages/invited-bidders", {
  summary: "Invite bidders into RA Stages",
  description:
    "Invites one or more bidders into rfi/rfp/rfq — never directly into the auction itself — and enqueues an invitation email to each. Idempotent per already-active-invited bidder.",
  params: AuctionIdParam,
  body: inviteBiddersSchema,
  responses: {
    201: OkBody,
    400: { description: "Invalid input, or no stage is available to invite into.", schema: ValidationErrorBody },
  },
});

r.delete("/:auctionId/ra-stages/invited-bidders/:bidderId", {
  summary: "Withdraw an invited bidder",
  description:
    "Deactivates the bidder's RA Stages invitation. Historical responses and answers are kept as an audit trail, not deleted.",
  params: AuctionIdBidderIdParam,
  responses: { 200: OkBody },
});

r.get("/:auctionId/ra-stages/:stageKey/responses", {
  summary: "List a stage's bidder responses",
  params: AuctionIdStageKeyParam,
  responses: { 200: AuctionRaStageResponseRowList },
});

r.get("/:auctionId/ra-stages/:stageKey/responses/:bidderId", {
  summary: "Get one bidder's response detail for a stage",
  description: "Includes resolved, signed download URLs for any file-upload answers.",
  params: AuctionIdStageKeyBidderIdParam,
  responses: {
    200: AuctionRaStageResponseDetail,
    404: { description: "Stage or response not found.", schema: ErrorBody },
  },
});

r.post("/:auctionId/ra-stages/:stageKey/responses/:bidderId/decision", {
  summary: "Shortlist or reject a bidder's stage response",
  description:
    "Informational only — this never grants or revokes the bidder's ability to bid in the actual auction; attaching bidders to the auction stays a separate, fully manual action in the Attach Bidders tab. When shortlisted, the bidder's response row is automatically created in the next enabled stage.",
  params: AuctionIdStageKeyBidderIdParam,
  body: setStageDecisionSchema,
  responses: {
    200: OkBody,
    400: { description: "Rejection reason required when rejecting.", schema: ValidationErrorBody },
    404: { description: "Stage or response not found.", schema: ErrorBody },
  },
});

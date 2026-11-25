import { z } from "../zod.js";

// Mirrors AuctionRaStageDto / AuctionRaStagesDto in services/auction-ra-stages/dto.ts.

const QuestionOption = z.object({ value: z.string() });

const QuestionFileUpload = z.object({
  allowedFileTypes: z.array(z.string()),
  maxFileSizeMb: z.number().int().nullable(),
});

const AuctionRaStageQuestion = z
  .object({
    id: z.string(),
    question: z.string(),
    answerType: z.string(),
    weight: z.number().int(),
    required: z.boolean(),
    options: z.array(QuestionOption),
    fileUpload: QuestionFileUpload,
  })
  .openapi("AuctionRaStageQuestion");

export const AuctionRaStage = z
  .object({
    key: z.enum(["rfi", "rfp", "rfq"]),
    enabled: z.boolean(),
    status: z
      .enum(["draft", "published", "closed"])
      .openapi({ description: "Mirrors the auction's own status model, set automatically by a background tick from startsAt/endsAt — no manual open/close/reopen exists." }),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    publishedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    questions: z.array(AuctionRaStageQuestion),
    lineItems: z
      .array(z.unknown())
      .openapi({ description: "Always empty — RFQ line items are read from the auction's real lots instead." }),
  })
  .openapi("AuctionRaStage");

export const AuctionRaStages = z
  .object({ rfi: AuctionRaStage, rfp: AuctionRaStage, rfq: AuctionRaStage })
  .openapi("AuctionRaStages");

export const AuctionRaStageResponseRow = z
  .object({
    bidderId: z.number().int(),
    bidderName: z.string(),
    status: z.enum(["invited", "draft", "submitted"]),
    submittedAt: z.string().nullable(),
    answered: z.number().int(),
    requiredAnswered: z.number().int(),
    isShortlisted: z
      .boolean()
      .nullable()
      .openapi({ description: "Informational only — never grants or revokes the bidder's ability to bid in the actual auction." }),
    rejectionReason: z.string().nullable(),
  })
  .openapi("AuctionRaStageResponseRow");

export const AuctionRaStageResponseRowList = z
  .array(AuctionRaStageResponseRow)
  .openapi("AuctionRaStageResponseRowList");

const AuctionRaStageAnswerFile = z.object({
  fileName: z.string(),
  sizeLabel: z.string(),
  url: z.string(),
});

const AuctionRaStageAnswerValue = z.union([
  z.string(),
  z.array(z.string()),
  z.array(AuctionRaStageAnswerFile),
  z.null(),
]);

const AuctionRaStageAnswer = z
  .object({ questionId: z.string(), value: AuctionRaStageAnswerValue })
  .openapi("AuctionRaStageAnswer");

export const AuctionRaStageResponseDetail = AuctionRaStageResponseRow.extend({
  answers: z.array(AuctionRaStageAnswer),
}).openapi("AuctionRaStageResponseDetail");

export const AuctionRaStageInvitableBidder = z
  .object({
    bidderId: z.number().int(),
    companyName: z.string(),
    materials: z.array(z.string()),
  })
  .openapi("AuctionRaStageInvitableBidder");

export const AuctionRaStageInvitableBidderList = z
  .array(AuctionRaStageInvitableBidder)
  .openapi("AuctionRaStageInvitableBidderList");

const FilterOption = z.object({ value: z.string(), label: z.string() });

export const AuctionRaStageInviteFilterOptions = z
  .object({ materials: z.array(FilterOption), locations: z.array(FilterOption) })
  .openapi("AuctionRaStageInviteFilterOptions");

export const AuctionRaStageInvitedBidder = z
  .object({
    bidderId: z.number().int(),
    companyName: z.string(),
    invitedBy: z.string(),
    invitedAt: z.string(),
    entryStages: z
      .array(z.string())
      .openapi({ description: "RFI/RFP/RFQ labels only — a stage invitation never carries the auction itself as an entry point." }),
  })
  .openapi("AuctionRaStageInvitedBidder");

export const AuctionRaStageInvitedBidderList = z
  .array(AuctionRaStageInvitedBidder)
  .openapi("AuctionRaStageInvitedBidderList");

export const ActiveRaAuction = z
  .object({
    auctionId: z.number().int(),
    auctionNumber: z.string().nullable(),
    clientName: z.string().nullable(),
    enabledStages: z.array(z.enum(["rfi", "rfp", "rfq"])),
  })
  .openapi("ActiveRaAuction");

export const ActiveRaAuctionList = z.array(ActiveRaAuction).openapi("ActiveRaAuctionList");

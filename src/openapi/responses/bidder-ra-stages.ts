import { z } from "../zod.js";

// Mirrors BidderStageInvitationDto / BidderStageDetailDto in
// services/auction-ra-stages/bidder-submission.service.ts.

export const BidderRaStageInvitation = z
  .object({
    stageKey: z.enum(["rfi", "rfp", "rfq"]),
    status: z.enum(["invited", "submitted"]),
    isShortlisted: z.boolean().nullable(),
    rejectionReason: z.string().nullable(),
  })
  .openapi("BidderRaStageInvitation");

export const BidderRaStageInvitationList = z
  .array(BidderRaStageInvitation)
  .openapi("BidderRaStageInvitationList");

const QuestionOption = z.object({ value: z.string() });

const QuestionFileUpload = z.object({
  allowedFileTypes: z.array(z.string()),
  maxFileSizeMb: z.number().int().nullable(),
});

const BidderRaStageQuestion = z
  .object({
    id: z.string(),
    question: z.string(),
    answerType: z.string(),
    weight: z.number().int(),
    required: z.boolean(),
    options: z.array(QuestionOption),
    fileUpload: QuestionFileUpload,
  })
  .openapi("BidderRaStageQuestion");

export const BidderRaStageDetail = z
  .object({
    stageKey: z.enum(["rfi", "rfp", "rfq"]),
    stageStatus: z.enum(["draft", "published", "closed"]),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    responseStatus: z.enum(["invited", "submitted"]),
    isShortlisted: z.boolean().nullable(),
    rejectionReason: z.string().nullable(),
    questions: z.array(BidderRaStageQuestion),
    answers: z
      .record(z.union([z.string(), z.array(z.string()), z.null()]))
      .openapi({ description: "Question id -> previously submitted answer, for resuming a draft." }),
  })
  .openapi("BidderRaStageDetail");

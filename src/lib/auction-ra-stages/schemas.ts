import { AuctionRaStagesValidationMessages } from "@auctionit/messages/auction-ra-stages";
import { z } from "zod";
import { AUCTION_RA_STAGE_KEYS } from "../../db/schema/question-templates.js";
import { questionInputSchema } from "../question-templates/schemas.js";

export const saveStagesConfigSchema = z.object({
  enabledKeys: z.array(z.enum(AUCTION_RA_STAGE_KEYS)),
});
export type SaveStagesConfigInput = z.infer<typeof saveStagesConfigSchema>;

export const saveStageSetupSchema = z.object({
  questions: z.array(questionInputSchema).default([]),
  /** Accepted for request-shape compatibility with the frontend; always discarded. */
  lineItems: z.array(z.unknown()).optional(),
  startsAt: z
    .string()
    .trim()
    .min(1, AuctionRaStagesValidationMessages.STARTS_AT_REQUIRED),
  endsAt: z.string().trim().min(1, AuctionRaStagesValidationMessages.ENDS_AT_REQUIRED),
});
export type SaveStageSetupInput = z.infer<typeof saveStageSetupSchema>;

export const setStageDecisionSchema = z
  .object({
    isShortlisted: z.boolean(),
    rejectionReason: z.string().trim().max(500).nullable().optional(),
  })
  .refine(
    (d) => d.isShortlisted || (d.rejectionReason != null && d.rejectionReason.length > 0),
    {
      message: AuctionRaStagesValidationMessages.REJECTION_REASON_REQUIRED,
      path: ["rejectionReason"],
    },
  );
export type SetStageDecisionInput = z.infer<typeof setStageDecisionSchema>;

export const inviteBiddersSchema = z.object({
  bidderIds: z
    .array(z.number().int().positive())
    .min(1, AuctionRaStagesValidationMessages.SELECT_AT_LEAST_ONE_BIDDER),
  entryStage: z.enum(AUCTION_RA_STAGE_KEYS).optional(),
});
export type InviteBiddersInput = z.infer<typeof inviteBiddersSchema>;

export const invitableBiddersQuerySchema = z.object({
  material: z.string().trim().optional(),
  location: z.string().trim().optional(),
});

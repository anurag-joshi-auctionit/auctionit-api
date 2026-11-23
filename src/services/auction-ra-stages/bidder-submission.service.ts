import { BidderRaStagesErrorMessages, BidderRaStagesValidationMessages } from "@auctionit/messages/bidder-ra-stages";
import { formatUtcNow } from "@auctionit/lib/date";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStageInvitedBidders } from "../../db/schema/auction-ra-stage-invitations.js";
import { auctionRaStageQuestions, auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import {
  auctionRaStageAnswers,
  auctionRaStageResponses,
} from "../../db/schema/auction-ra-stage-responses.js";
import { AUCTION_RA_STAGE_KEYS, type AuctionRaStageKey } from "../../db/schema/question-templates.js";
import { filesService } from "../files.service.js";
import { earliestEnabledStageKey, questionRowToDto, type AuctionRaStageQuestionDto } from "./dto.js";
import { AuctionRaStageValidationError } from "./errors.js";

export type BidderStageInvitationDto = {
  stageKey: AuctionRaStageKey;
  status: "invited" | "submitted";
  isShortlisted: boolean | null;
  rejectionReason: string | null;
};

export type BidderStageDetailDto = {
  stageKey: AuctionRaStageKey;
  stageStatus: "draft" | "published" | "closed";
  startsAt: string | null;
  endsAt: string | null;
  responseStatus: "invited" | "submitted";
  isShortlisted: boolean | null;
  rejectionReason: string | null;
  questions: AuctionRaStageQuestionDto[];
  answers: Record<string, string | string[] | null>;
};

export type SubmitAnswerValue = string | string[] | undefined;

async function requireResponseRow(
  auctionId: number,
  stageKey: AuctionRaStageKey,
  bidderId: number,
) {
  const [row] = await db
    .select({
      responseId: auctionRaStageResponses.id,
      responseStatus: auctionRaStageResponses.status,
      isShortlisted: auctionRaStageResponses.isShortlisted,
      rejectionReason: auctionRaStageResponses.rejectionReason,
      stageId: auctionRaStages.id,
      stageStatus: auctionRaStages.status,
      startsAt: auctionRaStages.startsAt,
      endsAt: auctionRaStages.endsAt,
    })
    .from(auctionRaStageResponses)
    .innerJoin(auctionRaStages, eq(auctionRaStages.id, auctionRaStageResponses.auctionRaStageId))
    .where(
      and(
        eq(auctionRaStages.auctionId, auctionId),
        eq(auctionRaStages.stageKey, stageKey),
        eq(auctionRaStageResponses.bidderId, bidderId),
      ),
    )
    .limit(1);

  if (row) return row;

  // No response row yet — check if the bidder is actively invited to this auction.
  // A response row may be missing for bidders invited before the row-creation
  // logic was added; create it on first access.
  const [invitation] = await db
    .select({ entryStage: auctionRaStageInvitedBidders.entryStage })
    .from(auctionRaStageInvitedBidders)
    .where(
      and(
        eq(auctionRaStageInvitedBidders.auctionId, auctionId),
        eq(auctionRaStageInvitedBidders.bidderId, bidderId),
        eq(auctionRaStageInvitedBidders.isActive, true),
      ),
    )
    .limit(1);

  if (!invitation) {
    throw new AuctionRaStageValidationError(BidderRaStagesErrorMessages.NOT_INVITED);
  }

  // Reject access to stages before the bidder's entry point.
  const entryIndex = invitation.entryStage ? AUCTION_RA_STAGE_KEYS.indexOf(invitation.entryStage) : 0;
  if (AUCTION_RA_STAGE_KEYS.indexOf(stageKey) < entryIndex) {
    throw new AuctionRaStageValidationError(BidderRaStagesErrorMessages.NOT_INVITED);
  }

  const [stageRow] = await db
    .select({
      stageId: auctionRaStages.id,
      stageStatus: auctionRaStages.status,
      startsAt: auctionRaStages.startsAt,
      endsAt: auctionRaStages.endsAt,
    })
    .from(auctionRaStages)
    .where(and(eq(auctionRaStages.auctionId, auctionId), eq(auctionRaStages.stageKey, stageKey)))
    .limit(1);

  if (!stageRow) {
    throw new AuctionRaStageValidationError(BidderRaStagesErrorMessages.NOT_INVITED);
  }

  const now = formatUtcNow();
  const [created] = await db
    .insert(auctionRaStageResponses)
    .values({ auctionRaStageId: stageRow.stageId, bidderId, status: "invited", createdAt: now })
    .onConflictDoNothing()
    .returning({
      responseId: auctionRaStageResponses.id,
      responseStatus: auctionRaStageResponses.status,
      isShortlisted: auctionRaStageResponses.isShortlisted,
      rejectionReason: auctionRaStageResponses.rejectionReason,
    });

  if (!created) {
    throw new AuctionRaStageValidationError(BidderRaStagesErrorMessages.NOT_INVITED);
  }

  return { ...created, ...stageRow };
}

export const bidderRaStageSubmissionService = {
  async listMyInvitations(
    auctionId: number,
    bidderId: number,
  ): Promise<BidderStageInvitationDto[]> {
    const rows = await db
      .select({
        stageKey: auctionRaStages.stageKey,
        status: auctionRaStageResponses.status,
        isShortlisted: auctionRaStageResponses.isShortlisted,
        rejectionReason: auctionRaStageResponses.rejectionReason,
      })
      .from(auctionRaStageResponses)
      .innerJoin(auctionRaStages, eq(auctionRaStages.id, auctionRaStageResponses.auctionRaStageId))
      .where(and(eq(auctionRaStages.auctionId, auctionId), eq(auctionRaStageResponses.bidderId, bidderId)));

    if (rows.length > 0) {
      return rows.map((r) => ({
        stageKey: r.stageKey,
        status: r.status,
        isShortlisted: r.isShortlisted ?? null,
        rejectionReason: r.rejectionReason ?? null,
      }));
    }

    // Fallback: bidder was invited via the invitation table but has no response
    // rows yet (e.g. invited before row-creation was wired up). Synthesise the
    // entry-stage invitation so the bidder can see the stage in the app.
    const [invitation] = await db
      .select({ entryStage: auctionRaStageInvitedBidders.entryStage })
      .from(auctionRaStageInvitedBidders)
      .where(
        and(
          eq(auctionRaStageInvitedBidders.auctionId, auctionId),
          eq(auctionRaStageInvitedBidders.bidderId, bidderId),
          eq(auctionRaStageInvitedBidders.isActive, true),
        ),
      )
      .limit(1);

    if (!invitation) return [];

    const stageRows = await db
      .select({ stageKey: auctionRaStages.stageKey, enabled: auctionRaStages.enabled })
      .from(auctionRaStages)
      .where(eq(auctionRaStages.auctionId, auctionId));

    const entryStageKey = invitation.entryStage ?? earliestEnabledStageKey(stageRows);
    if (!entryStageKey) return [];

    return [{ stageKey: entryStageKey, status: "invited", isShortlisted: null, rejectionReason: null }];
  },

  async getMyStage(
    auctionId: number,
    stageKey: AuctionRaStageKey,
    bidderId: number,
  ): Promise<BidderStageDetailDto> {
    const row = await requireResponseRow(auctionId, stageKey, bidderId);

    const questionRows = await db
      .select()
      .from(auctionRaStageQuestions)
      .where(eq(auctionRaStageQuestions.auctionRaStageId, row.stageId));

    const answerRows = await db
      .select()
      .from(auctionRaStageAnswers)
      .where(eq(auctionRaStageAnswers.responseId, row.responseId));

    const answers: Record<string, string | string[] | null> = {};
    for (const a of answerRows) {
      answers[String(a.stageQuestionId)] = a.valueChoices ?? a.valueText ?? null;
    }

    return {
      stageKey,
      stageStatus: row.stageStatus,
      startsAt: row.startsAt ?? null,
      endsAt: row.endsAt ?? null,
      responseStatus: row.responseStatus,
      isShortlisted: row.isShortlisted ?? null,
      rejectionReason: row.rejectionReason ?? null,
      questions: questionRows.map(questionRowToDto),
      answers,
    };
  },

  async submit(
    auctionId: number,
    stageKey: AuctionRaStageKey,
    bidderId: number,
    answers: Record<string, SubmitAnswerValue>,
    files: { questionId: string; filename: string; mimetype: string; buffer: Buffer }[],
    userId: number,
  ): Promise<void> {
    const row = await requireResponseRow(auctionId, stageKey, bidderId);

    if (row.responseStatus === "submitted") {
      throw new AuctionRaStageValidationError(BidderRaStagesErrorMessages.ALREADY_SUBMITTED);
    }
    if (row.stageStatus !== "published") {
      throw new AuctionRaStageValidationError(BidderRaStagesErrorMessages.STAGE_NOT_OPEN);
    }

    const questionRows = await db
      .select()
      .from(auctionRaStageQuestions)
      .where(eq(auctionRaStageQuestions.auctionRaStageId, row.stageId));

    const filesByQuestionId = new Map<string, typeof files>();
    for (const f of files) {
      const arr = filesByQuestionId.get(f.questionId) ?? [];
      arr.push(f);
      filesByQuestionId.set(f.questionId, arr);
    }

    for (const q of questionRows) {
      if (!q.required) continue;
      const qid = String(q.id);
      if (q.answerType === "file_upload") {
        if (!filesByQuestionId.has(qid)) {
          throw new AuctionRaStageValidationError(
            BidderRaStagesValidationMessages.ALL_REQUIRED_QUESTIONS_MUST_BE_ANSWERED,
          );
        }
        continue;
      }
      const value = answers[qid];
      const hasValue = Array.isArray(value) ? value.length > 0 : !!value && value.length > 0;
      if (!hasValue) {
        throw new AuctionRaStageValidationError(
          BidderRaStagesValidationMessages.ALL_REQUIRED_QUESTIONS_MUST_BE_ANSWERED,
        );
      }
    }

    const now = formatUtcNow();
    await db.transaction(async (tx) => {
      await tx
        .delete(auctionRaStageAnswers)
        .where(eq(auctionRaStageAnswers.responseId, row.responseId));

      for (const q of questionRows) {
        const qid = String(q.id);
        if (q.answerType === "file_upload") {
          const uploads = filesByQuestionId.get(qid) ?? [];
          if (uploads.length === 0) continue;
          const uploaded = await Promise.all(
            uploads.map((f) =>
              filesService.upload({
                userId,
                filename: f.filename,
                contentType: f.mimetype,
                body: f.buffer,
              }),
            ),
          );
          await tx.insert(auctionRaStageAnswers).values({
            responseId: row.responseId,
            stageQuestionId: q.id,
            fileRefs: uploaded.map((f) => ({
              fileId: f.id,
              fileName: f.filename,
              sizeLabel: "",
            })),
          });
          continue;
        }

        const value = answers[qid];
        if (value === undefined) continue;
        if (q.answerType === "single_choice" || q.answerType === "multiple_choice") {
          await tx.insert(auctionRaStageAnswers).values({
            responseId: row.responseId,
            stageQuestionId: q.id,
            valueChoices: Array.isArray(value) ? value : [value],
          });
        } else {
          await tx.insert(auctionRaStageAnswers).values({
            responseId: row.responseId,
            stageQuestionId: q.id,
            valueText: Array.isArray(value) ? value[0] ?? null : value,
          });
        }
      }

      await tx
        .update(auctionRaStageResponses)
        .set({ status: "submitted", submittedAt: now, updatedAt: now })
        .where(eq(auctionRaStageResponses.id, row.responseId));
    });
  },
};

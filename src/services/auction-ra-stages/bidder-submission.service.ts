import { BidderRaStagesErrorMessages, BidderRaStagesValidationMessages } from "@auctionit/messages/bidder-ra-stages";
import { formatUtcNow } from "@auctionit/lib/date";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStageInvitedBidders } from "../../db/schema/auction-ra-stage-invitations.js";
import { auctionRaStageQuestions, auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import {
  auctionRaStageAnswers,
  auctionRaStageResponses,
} from "../../db/schema/auction-ra-stage-responses.js";
import { AUCTION_RA_STAGE_KEYS, type AuctionRaStageKey } from "../../db/schema/question-templates.js";
import { auctions } from "../../db/schema/auctions.js";
import { clients } from "../../db/schema/clients.js";
import { filesService, type FileListItem } from "../files.service.js";
import { questionRowToDto, type AuctionRaStageQuestionDto } from "./dto.js";
import { AuctionRaStageValidationError } from "./errors.js";

export type BidderStageListItemDto = {
  stageKey: AuctionRaStageKey;
  stageStatus: "draft" | "published" | "closed";
  startsAt: string | null;
  endsAt: string | null;
  questionCount: number;
  requiredQuestionCount: number;
  responseStatus: "invited" | "submitted" | null;
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

export type RaStageWindowDto = {
  auctionId: number;
  auctionNumber: string | null;
  clientName: string | null;
  stageKey: AuctionRaStageKey;
  stageStatus: "draft" | "published" | "closed";
  startsAt: string | null;
  endsAt: string | null;
  responseStatus: "invited" | "submitted";
  isShortlisted: boolean | null;
};

export async function listMyStageWindows(bidderId: number): Promise<RaStageWindowDto[]> {
  const rows = await db
    .select({
      auctionId: auctions.id,
      auctionNumber: auctions.auctionNumber,
      clientName: clients.companyName,
      stageKey: auctionRaStages.stageKey,
      stageStatus: auctionRaStages.status,
      startsAt: auctionRaStages.startsAt,
      endsAt: auctionRaStages.endsAt,
      responseStatus: auctionRaStageResponses.status,
      isShortlisted: auctionRaStageResponses.isShortlisted,
    })
    .from(auctionRaStageResponses)
    .innerJoin(auctionRaStages, eq(auctionRaStages.id, auctionRaStageResponses.auctionRaStageId))
    .innerJoin(auctions, and(eq(auctions.id, auctionRaStages.auctionId), eq(auctions.isActive, true)))
    .leftJoin(clients, eq(clients.id, auctions.clientId))
    .where(
      and(
        eq(auctionRaStageResponses.bidderId, bidderId),
        eq(auctions.status, "published"),
      ),
    );

  return rows
    .sort(
      (a, b) =>
        AUCTION_RA_STAGE_KEYS.indexOf(a.stageKey) - AUCTION_RA_STAGE_KEYS.indexOf(b.stageKey),
    )
    .map((r) => ({
      auctionId: r.auctionId,
      auctionNumber: r.auctionNumber ?? null,
      clientName: r.clientName ?? null,
      stageKey: r.stageKey,
      stageStatus: r.stageStatus,
      startsAt: r.startsAt ?? null,
      endsAt: r.endsAt ?? null,
      responseStatus: r.responseStatus,
      isShortlisted: r.isShortlisted ?? null,
    }));
}

export const bidderRaStageSubmissionService = {
  async listMyInvitations(
    auctionId: number,
    bidderId: number,
  ): Promise<BidderStageListItemDto[]> {
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

    const stages = await db
      .select({
        id: auctionRaStages.id,
        stageKey: auctionRaStages.stageKey,
        status: auctionRaStages.status,
        startsAt: auctionRaStages.startsAt,
        endsAt: auctionRaStages.endsAt,
      })
      .from(auctionRaStages)
      .where(
        and(
          eq(auctionRaStages.auctionId, auctionId),
          eq(auctionRaStages.enabled, true),
        ),
      );

    if (stages.length === 0) return [];

    const stageIds = stages.map((s) => s.id);

    const questionCounts = await db
      .select({
        auctionRaStageId: auctionRaStageQuestions.auctionRaStageId,
        count: sql<number>`count(*)::int`,
        requiredCount: sql<number>`count(*) filter (where ${auctionRaStageQuestions.required})::int`,
      })
      .from(auctionRaStageQuestions)
      .where(inArray(auctionRaStageQuestions.auctionRaStageId, stageIds))
      .groupBy(auctionRaStageQuestions.auctionRaStageId);

    const countByStageId = new Map(questionCounts.map((q) => [q.auctionRaStageId, q]));

    const responses = await db
      .select({
        stageKey: auctionRaStages.stageKey,
        status: auctionRaStageResponses.status,
        isShortlisted: auctionRaStageResponses.isShortlisted,
        rejectionReason: auctionRaStageResponses.rejectionReason,
      })
      .from(auctionRaStageResponses)
      .innerJoin(auctionRaStages, eq(auctionRaStages.id, auctionRaStageResponses.auctionRaStageId))
      .where(
        and(
          eq(auctionRaStages.auctionId, auctionId),
          eq(auctionRaStageResponses.bidderId, bidderId),
        ),
      );

    const responseByStageKey = new Map(responses.map((r) => [r.stageKey, r]));

    const orderedStages = [...stages].sort(
      (a, b) =>
        AUCTION_RA_STAGE_KEYS.indexOf(a.stageKey) - AUCTION_RA_STAGE_KEYS.indexOf(b.stageKey),
    );

    return orderedStages.map((s) => {
      const counts = countByStageId.get(s.id);
      const response = responseByStageKey.get(s.stageKey);
      return {
        stageKey: s.stageKey,
        stageStatus: s.status,
        startsAt: s.startsAt ?? null,
        endsAt: s.endsAt ?? null,
        questionCount: counts?.count ?? 0,
        requiredQuestionCount: counts?.requiredCount ?? 0,
        responseStatus: response?.status ?? null,
        isShortlisted: response?.isShortlisted ?? null,
        rejectionReason: response?.rejectionReason ?? null,
      };
    });
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
    const nowMs = Date.now();
    const windowOpen = row.startsAt ? new Date(row.startsAt).getTime() <= nowMs : false;
    const windowClosed = row.endsAt ? new Date(row.endsAt).getTime() <= nowMs : false;
    if (!windowOpen || windowClosed) {
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

    // Upload files to R2 + files table before the transaction so the
    // transaction body is DB-only. Calling filesService.upload() (which uses
    // the global db) from inside db.transaction() would use a separate pool
    // connection while the transaction holds one, risking pool starvation.
    const uploadedByQuestionId = new Map<string, FileListItem[]>();
    for (const q of questionRows) {
      if (q.answerType !== "file_upload") continue;
      const qid = String(q.id);
      const uploads = filesByQuestionId.get(qid) ?? [];
      if (uploads.length === 0) continue;
      uploadedByQuestionId.set(
        qid,
        await Promise.all(
          uploads.map((f) =>
            filesService.upload({
              userId,
              filename: f.filename,
              contentType: f.mimetype,
              body: f.buffer,
            }),
          ),
        ),
      );
    }

    const now = formatUtcNow();
    await db.transaction(async (tx) => {
      await tx
        .delete(auctionRaStageAnswers)
        .where(eq(auctionRaStageAnswers.responseId, row.responseId));

      for (const q of questionRows) {
        const qid = String(q.id);
        if (q.answerType === "file_upload") {
          const uploaded = uploadedByQuestionId.get(qid) ?? [];
          if (uploaded.length === 0) continue;
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

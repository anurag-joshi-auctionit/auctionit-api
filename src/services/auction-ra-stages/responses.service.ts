import { formatUtcNow } from "@auctionit/lib/date";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStageQuestions, auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import {
  auctionRaStageAnswers,
  auctionRaStageResponses,
} from "../../db/schema/auction-ra-stage-responses.js";
import { bidders } from "../../db/schema/bidders.js";
import type { AuctionRaStageKey } from "../../db/schema/question-templates.js";
import { files } from "../../db/schema/files.js";
import { getSignedDownloadUrl } from "../../lib/r2.js";
import type { SetStageDecisionInput } from "../../lib/auction-ra-stages/schemas.js";
import { requireReverseAuction } from "./auction-context.js";
import { ensureStagesExist, nextEnabledStageKey } from "./dto.js";
import { AuctionRaStageNotFoundError } from "./errors.js";

export type StageResponseRowDto = {
  bidderId: number;
  bidderName: string;
  status: "invited" | "submitted";
  submittedAt: string | null;
  answered: number;
  requiredAnswered: number;
  isShortlisted: boolean | null;
  rejectionReason: string | null;
};

export type StageAnswerValueDto =
  | string
  | string[]
  | { fileName: string; sizeLabel: string; url: string }[]
  | null;

export type StageAnswerDto = { questionId: string; value: StageAnswerValueDto };

export type StageResponseDetailDto = StageResponseRowDto & { answers: StageAnswerDto[] };

async function getStageOrThrow(auctionId: number, stageKey: AuctionRaStageKey) {
  const rows = await ensureStagesExist(auctionId);
  const stage = rows.find((r) => r.stageKey === stageKey);
  if (!stage) throw new AuctionRaStageNotFoundError();
  return { stage, rows };
}

function answerValue(
  answerType: string,
  row: typeof auctionRaStageAnswers.$inferSelect,
  fileUrlById: Map<number, string>,
  fileNameById: Map<number, { fileName: string; sizeLabel: string }>,
): StageAnswerValueDto {
  if (answerType === "file_upload") {
    if (!row.fileRefs || row.fileRefs.length === 0) return null;
    return row.fileRefs.map((ref) => ({
      fileName: fileNameById.get(ref.fileId)?.fileName ?? ref.fileName,
      sizeLabel: fileNameById.get(ref.fileId)?.sizeLabel ?? ref.sizeLabel,
      url: fileUrlById.get(ref.fileId) ?? "",
    }));
  }
  if (answerType === "single_choice" || answerType === "multiple_choice") {
    return row.valueChoices ?? [];
  }
  return row.valueText ?? null;
}

export const auctionRaStagesResponsesService = {
  async listResponses(
    auctionId: number,
    stageKey: AuctionRaStageKey,
  ): Promise<StageResponseRowDto[]> {
    await requireReverseAuction(auctionId);
    const { stage } = await getStageOrThrow(auctionId, stageKey);

    const questionRows = await db
      .select({ id: auctionRaStageQuestions.id, required: auctionRaStageQuestions.required })
      .from(auctionRaStageQuestions)
      .where(eq(auctionRaStageQuestions.auctionRaStageId, stage.id));
    const requiredQuestionIds = new Set(questionRows.filter((q) => q.required).map((q) => q.id));

    const responseRows = await db
      .select({
        id: auctionRaStageResponses.id,
        bidderId: auctionRaStageResponses.bidderId,
        bidderName: bidders.companyName,
        status: auctionRaStageResponses.status,
        submittedAt: auctionRaStageResponses.submittedAt,
        isShortlisted: auctionRaStageResponses.isShortlisted,
        rejectionReason: auctionRaStageResponses.rejectionReason,
      })
      .from(auctionRaStageResponses)
      .innerJoin(bidders, eq(bidders.id, auctionRaStageResponses.bidderId))
      .where(eq(auctionRaStageResponses.auctionRaStageId, stage.id));

    if (responseRows.length === 0) return [];

    const answerRows = await db
      .select({
        responseId: auctionRaStageAnswers.responseId,
        stageQuestionId: auctionRaStageAnswers.stageQuestionId,
      })
      .from(auctionRaStageAnswers)
      .where(inArray(auctionRaStageAnswers.responseId, responseRows.map((r) => r.id)));

    return responseRows.map((row) => {
      const answers = answerRows.filter((a) => a.responseId === row.id);
      return {
        bidderId: row.bidderId,
        bidderName: row.bidderName,
        status: row.status,
        submittedAt: row.submittedAt ?? null,
        answered: answers.length,
        requiredAnswered: answers.filter((a) => requiredQuestionIds.has(a.stageQuestionId)).length,
        isShortlisted: row.isShortlisted ?? null,
        rejectionReason: row.rejectionReason ?? null,
      };
    });
  },

  async getResponseDetail(
    auctionId: number,
    stageKey: AuctionRaStageKey,
    bidderId: number,
  ): Promise<StageResponseDetailDto> {
    await requireReverseAuction(auctionId);
    const { stage } = await getStageOrThrow(auctionId, stageKey);

    const [response] = await db
      .select({
        id: auctionRaStageResponses.id,
        bidderId: auctionRaStageResponses.bidderId,
        bidderName: bidders.companyName,
        status: auctionRaStageResponses.status,
        submittedAt: auctionRaStageResponses.submittedAt,
        isShortlisted: auctionRaStageResponses.isShortlisted,
        rejectionReason: auctionRaStageResponses.rejectionReason,
      })
      .from(auctionRaStageResponses)
      .innerJoin(bidders, eq(bidders.id, auctionRaStageResponses.bidderId))
      .where(
        and(
          eq(auctionRaStageResponses.auctionRaStageId, stage.id),
          eq(auctionRaStageResponses.bidderId, bidderId),
        ),
      )
      .limit(1);
    if (!response) throw new AuctionRaStageNotFoundError();

    const questionRows = await db
      .select()
      .from(auctionRaStageQuestions)
      .where(eq(auctionRaStageQuestions.auctionRaStageId, stage.id));
    const questionById = new Map(questionRows.map((q) => [q.id, q]));

    const answerRows = await db
      .select()
      .from(auctionRaStageAnswers)
      .where(eq(auctionRaStageAnswers.responseId, response.id));

    const allFileIds = answerRows.flatMap((a) => (a.fileRefs ?? []).map((f) => f.fileId));
    const fileRows = allFileIds.length
      ? await db.select().from(files).where(inArray(files.id, allFileIds))
      : [];
    const fileUrlById = new Map(
      await Promise.all(
        fileRows.map(async (f) => [f.id, await getSignedDownloadUrl(f.s3Key)] as const),
      ),
    );
    const fileNameById = new Map(
      fileRows.map((f) => [f.id, { fileName: f.filename, sizeLabel: "" }] as const),
    );

    const requiredQuestionIds = new Set(
      questionRows.filter((q) => q.required).map((q) => q.id),
    );

    return {
      bidderId: response.bidderId,
      bidderName: response.bidderName,
      status: response.status,
      submittedAt: response.submittedAt ?? null,
      answered: answerRows.length,
      requiredAnswered: answerRows.filter((a) => requiredQuestionIds.has(a.stageQuestionId)).length,
      isShortlisted: response.isShortlisted ?? null,
      rejectionReason: response.rejectionReason ?? null,
      answers: answerRows.map((row) => {
        const question = questionById.get(row.stageQuestionId);
        return {
          questionId: String(row.stageQuestionId),
          value: answerValue(question?.answerType ?? "short_text", row, fileUrlById, fileNameById),
        };
      }),
    };
  },

  async setDecision(
    auctionId: number,
    stageKey: AuctionRaStageKey,
    bidderId: number,
    input: SetStageDecisionInput,
    userId: number,
  ): Promise<void> {
    await requireReverseAuction(auctionId);
    const { stage, rows } = await getStageOrThrow(auctionId, stageKey);

    const [response] = await db
      .select({ id: auctionRaStageResponses.id })
      .from(auctionRaStageResponses)
      .where(
        and(
          eq(auctionRaStageResponses.auctionRaStageId, stage.id),
          eq(auctionRaStageResponses.bidderId, bidderId),
        ),
      )
      .limit(1);
    if (!response) throw new AuctionRaStageNotFoundError();

    const now = formatUtcNow();
    await db
      .update(auctionRaStageResponses)
      .set({
        isShortlisted: input.isShortlisted,
        rejectionReason: input.isShortlisted ? null : input.rejectionReason ?? null,
        decidedBy: userId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(auctionRaStageResponses.id, response.id));

    // Informational progression only — shortlisting here never writes to the
    // auction's real bidder pool. That hand-off is deliberately out of scope.
    if (input.isShortlisted) {
      const next = nextEnabledStageKey(rows, stageKey);
      if (next) {
        const nextStage = rows.find((r) => r.stageKey === next);
        if (nextStage) {
          const [existingNext] = await db
            .select({ id: auctionRaStageResponses.id })
            .from(auctionRaStageResponses)
            .where(
              and(
                eq(auctionRaStageResponses.auctionRaStageId, nextStage.id),
                eq(auctionRaStageResponses.bidderId, bidderId),
              ),
            )
            .limit(1);
          if (!existingNext) {
            await db.insert(auctionRaStageResponses).values({
              auctionRaStageId: nextStage.id,
              bidderId,
              status: "invited",
              createdAt: now,
            });
          }
        }
      }
    }
  },
};

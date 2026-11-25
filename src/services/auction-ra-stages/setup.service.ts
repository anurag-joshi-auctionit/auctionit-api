import { AuctionRaStagesErrorMessages, AuctionRaStagesValidationMessages } from "@auctionit/messages/auction-ra-stages";
import { formatUtcNow } from "@auctionit/lib/date";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStageQuestions, auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import type { AuctionRaStageKey } from "../../db/schema/question-templates.js";
import type { SaveStageSetupInput } from "../../lib/auction-ra-stages/schemas.js";
import { requireReverseAuction } from "./auction-context.js";
import {
  ensureStagesExist,
  isStageLocked,
  loadStagesDto,
  nextEnabledStageKey,
  type AuctionRaStagesDto,
} from "./dto.js";
import { AuctionRaStageValidationError } from "./errors.js";
import { runRaStageLifecycleSync } from "./lifecycle-tick.service.js";

export const auctionRaStagesSetupService = {
  async saveStageSetup(
    auctionId: number,
    stageKey: AuctionRaStageKey,
    input: SaveStageSetupInput,
    userId: number,
  ): Promise<AuctionRaStagesDto> {
    const ctx = await requireReverseAuction(auctionId);
    const rows = await ensureStagesExist(auctionId);
    const stage = rows.find((r) => r.stageKey === stageKey);
    if (!stage) throw new AuctionRaStageValidationError(AuctionRaStagesErrorMessages.STAGE_NOT_FOUND);
    const locked = await isStageLocked(stage.id);

    if (locked) {
      // Questions and startsAt are locked — only endsAt may be updated.
      const endsAt = new Date(input.endsAt);
      if (Number.isNaN(endsAt.getTime())) {
        throw new AuctionRaStageValidationError(AuctionRaStagesValidationMessages.ENDS_AT_REQUIRED);
      }
      if (stage.startsAt && endsAt.getTime() <= new Date(stage.startsAt).getTime()) {
        throw new AuctionRaStageValidationError(AuctionRaStagesValidationMessages.ENDS_AT_BEFORE_STARTS_AT);
      }
      const nextKey = nextEnabledStageKey(rows, stageKey);
      const nextStage = nextKey ? rows.find((r) => r.stageKey === nextKey) : null;
      if (!nextStage) {
        const auctionStartsAt = new Date(ctx.auctionStartsAt);
        if (endsAt.getTime() >= auctionStartsAt.getTime()) {
          throw new AuctionRaStageValidationError(AuctionRaStagesValidationMessages.ENDS_AT_AFTER_AUCTION_START);
        }
      }
      const now = formatUtcNow();
      await db
        .update(auctionRaStages)
        .set({ endsAt: input.endsAt, updatedAt: now, updatedBy: userId })
        .where(eq(auctionRaStages.id, stage.id));
      await runRaStageLifecycleSync({ auctionId });
      return loadStagesDto(auctionId);
    }

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new AuctionRaStageValidationError(AuctionRaStagesValidationMessages.STARTS_AT_REQUIRED);
    }
    if (Number.isNaN(endsAt.getTime())) {
      throw new AuctionRaStageValidationError(AuctionRaStagesValidationMessages.ENDS_AT_REQUIRED);
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new AuctionRaStageValidationError(
        AuctionRaStagesValidationMessages.ENDS_AT_BEFORE_STARTS_AT,
      );
    }

    const nextKey = nextEnabledStageKey(rows, stageKey);
    const nextStage = nextKey ? rows.find((r) => r.stageKey === nextKey) : null;
    if (!nextStage) {
      const auctionStartsAt = new Date(ctx.auctionStartsAt);
      if (endsAt.getTime() >= auctionStartsAt.getTime()) {
        throw new AuctionRaStageValidationError(
          AuctionRaStagesValidationMessages.ENDS_AT_AFTER_AUCTION_START,
        );
      }
    }

    const now = formatUtcNow();
    await db.transaction(async (tx) => {
      await tx
        .update(auctionRaStages)
        .set({
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          updatedAt: now,
          updatedBy: userId,
        })
        .where(eq(auctionRaStages.id, stage.id));

      await tx
        .delete(auctionRaStageQuestions)
        .where(eq(auctionRaStageQuestions.auctionRaStageId, stage.id));

      if (input.questions.length > 0) {
        await tx.insert(auctionRaStageQuestions).values(
          input.questions.map((q, index) => ({
            auctionRaStageId: stage.id,
            displayOrder: index,
            questionText: q.question,
            answerType: q.answerType,
            weight: q.weight,
            required: q.required,
            options: q.options.map((o) => o.value),
            fileUploadAllowedTypes: q.fileUpload.allowedFileTypes,
            fileUploadMaxFileSizeMb: q.fileUpload.maxFileSizeMb,
          })),
        );
      }
    });

    await runRaStageLifecycleSync({ auctionId });
    return loadStagesDto(auctionId);
  },
};

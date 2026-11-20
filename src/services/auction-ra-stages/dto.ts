import { formatUtcNow } from "@auctionit/lib/date";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStageQuestions, auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import {
  AUCTION_RA_STAGE_KEYS,
  type AuctionRaStageKey,
} from "../../db/schema/question-templates.js";

export type AuctionRaStageQuestionDto = {
  id: string;
  question: string;
  answerType: string;
  weight: number;
  required: boolean;
  options: { value: string }[];
  fileUpload: { allowedFileTypes: string[]; maxFileSizeMb: number | null };
};

export type AuctionRaStageDto = {
  key: AuctionRaStageKey;
  enabled: boolean;
  status: "draft" | "published" | "closed";
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  questions: AuctionRaStageQuestionDto[];
  lineItems: [];
};

export type AuctionRaStagesDto = Record<AuctionRaStageKey, AuctionRaStageDto>;

export function questionRowToDto(
  row: typeof auctionRaStageQuestions.$inferSelect,
): AuctionRaStageQuestionDto {
  return {
    id: String(row.id),
    question: row.questionText,
    answerType: row.answerType,
    weight: row.weight,
    required: row.required,
    options: row.options.map((value) => ({ value })),
    fileUpload: {
      allowedFileTypes: row.fileUploadAllowedTypes,
      maxFileSizeMb: row.fileUploadMaxFileSizeMb ?? null,
    },
  };
}

export function isStageLocked(status: string): boolean {
  return status !== "draft";
}

/** Creates any missing rfi/rfp/rfq rows for the auction, then returns all three. */
export async function ensureStagesExist(
  auctionId: number,
): Promise<(typeof auctionRaStages.$inferSelect)[]> {
  const existing = await db
    .select()
    .from(auctionRaStages)
    .where(eq(auctionRaStages.auctionId, auctionId));

  const existingKeys = new Set(existing.map((r) => r.stageKey));
  const missing = AUCTION_RA_STAGE_KEYS.filter((k) => !existingKeys.has(k));
  if (missing.length === 0) return existing;

  const now = formatUtcNow();
  const inserted = await db
    .insert(auctionRaStages)
    .values(
      missing.map((key) => ({
        auctionId,
        stageKey: key,
        enabled: false,
        status: "draft" as const,
        createdAt: now,
      })),
    )
    .returning();

  return [...existing, ...inserted];
}

export async function loadStagesDto(auctionId: number): Promise<AuctionRaStagesDto> {
  const rows = await ensureStagesExist(auctionId);
  const ids = rows.map((r) => r.id);
  const questionRows = ids.length
    ? await db
        .select()
        .from(auctionRaStageQuestions)
        .where(inArray(auctionRaStageQuestions.auctionRaStageId, ids))
        .orderBy(asc(auctionRaStageQuestions.displayOrder))
    : [];

  const result = {} as AuctionRaStagesDto;
  for (const row of rows) {
    result[row.stageKey] = {
      key: row.stageKey,
      enabled: row.enabled,
      status: row.status,
      startsAt: row.startsAt ?? null,
      endsAt: row.endsAt ?? null,
      publishedAt: row.publishedAt ?? null,
      closedAt: row.closedAt ?? null,
      questions: questionRows
        .filter((q) => q.auctionRaStageId === row.id)
        .map(questionRowToDto),
      lineItems: [],
    };
  }
  return result;
}

/** The highest-order stage key that is currently enabled, or null if none are. */
export function lastEnabledStageKey(
  rows: { stageKey: AuctionRaStageKey; enabled: boolean }[],
): AuctionRaStageKey | null {
  const enabled = new Set(rows.filter((r) => r.enabled).map((r) => r.stageKey));
  for (let i = AUCTION_RA_STAGE_KEYS.length - 1; i >= 0; i--) {
    const key = AUCTION_RA_STAGE_KEYS[i]!;
    if (enabled.has(key)) return key;
  }
  return null;
}

/** The next enabled stage after `key`, or null if `key` is the last enabled one. */
export function nextEnabledStageKey(
  rows: { stageKey: AuctionRaStageKey; enabled: boolean }[],
  key: AuctionRaStageKey,
): AuctionRaStageKey | null {
  const enabled = new Set(rows.filter((r) => r.enabled).map((r) => r.stageKey));
  const startIndex = AUCTION_RA_STAGE_KEYS.indexOf(key) + 1;
  for (let i = startIndex; i < AUCTION_RA_STAGE_KEYS.length; i++) {
    const next = AUCTION_RA_STAGE_KEYS[i]!;
    if (enabled.has(next)) return next;
  }
  return null;
}

/** The previous enabled stage before `key`, or null if `key` is the first enabled one. */
export function previousEnabledStageKey(
  rows: { stageKey: AuctionRaStageKey; enabled: boolean }[],
  key: AuctionRaStageKey,
): AuctionRaStageKey | null {
  const enabled = new Set(rows.filter((r) => r.enabled).map((r) => r.stageKey));
  const startIndex = AUCTION_RA_STAGE_KEYS.indexOf(key) - 1;
  for (let i = startIndex; i >= 0; i--) {
    const prev = AUCTION_RA_STAGE_KEYS[i]!;
    if (enabled.has(prev)) return prev;
  }
  return null;
}

/** The earliest enabled stage, or null if none are enabled. */
export function earliestEnabledStageKey(
  rows: { stageKey: AuctionRaStageKey; enabled: boolean }[],
): AuctionRaStageKey | null {
  for (const key of AUCTION_RA_STAGE_KEYS) {
    if (rows.some((r) => r.stageKey === key && r.enabled)) return key;
  }
  return null;
}

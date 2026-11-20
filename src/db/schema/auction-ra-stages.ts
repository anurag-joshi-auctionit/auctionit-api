import {
  bigserial,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import {
  auctionRaStageKeyEnum,
  fileUploadTypeEnum,
  questionAnswerTypeEnum,
  questionTemplates,
} from "./question-templates.js";
import { users } from "./users.js";

/**
 * Mirrors the auction's own status vocabulary. There is no manual
 * open/close/reopen action: a background tick flips draft -> published ->
 * closed purely from `startsAt`/`endsAt` (see auction-ra-stages lifecycle
 * service). `enabled` is the separate "is this stage part of the flow at
 * all" flag; a disabled stage's status is frozen at `draft`.
 */
export const AUCTION_RA_STAGE_STATUSES = ["draft", "published", "closed"] as const;
export type AuctionRaStageStatus = (typeof AUCTION_RA_STAGE_STATUSES)[number];
export const auctionRaStageStatusEnum = pgEnum(
  "auction_ra_stage_status",
  AUCTION_RA_STAGE_STATUSES,
);

export const auctionRaStages = pgTable(
  "auction_ra_stages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    stageKey: auctionRaStageKeyEnum("stage_key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    status: auctionRaStageStatusEnum("status").notNull().default("draft"),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "string" }),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "string" }),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("auction_ra_stages_auction_id_stage_key_uidx").on(
      t.auctionId,
      t.stageKey,
    ),
  ],
);

/**
 * A stage's working question set. Copied from a question template at
 * apply-time (never a live FK) so a later template edit/delete can never
 * invalidate questions a bidder already answered.
 */
export const auctionRaStageQuestions = pgTable(
  "auction_ra_stage_questions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    auctionRaStageId: integer("auction_ra_stage_id")
      .notNull()
      .references(() => auctionRaStages.id, { onDelete: "cascade" }),
    displayOrder: integer("display_order").notNull(),
    questionText: varchar("question_text", { length: 500 }).notNull(),
    answerType: questionAnswerTypeEnum("answer_type").notNull(),
    weight: integer("weight").notNull().default(1),
    required: boolean("required").notNull().default(true),
    options: text("options").array().notNull().default([]),
    fileUploadAllowedTypes: fileUploadTypeEnum("file_upload_allowed_types")
      .array()
      .notNull()
      .default([]),
    fileUploadMaxFileSizeMb: integer("file_upload_max_file_size_mb"),
    /** Traceability only — never dereferenced for live behavior. */
    sourceTemplateId: integer("source_template_id").references(
      () => questionTemplates.id,
    ),
    sourceTemplateQuestionId: integer("source_template_question_id"),
  },
  (t) => [index("auction_ra_stage_questions_stage_id_idx").on(t.auctionRaStageId)],
);

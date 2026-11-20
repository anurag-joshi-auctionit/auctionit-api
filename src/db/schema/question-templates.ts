import {
  bigserial,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** RFI/RFP/RFQ — the three reverse-auction due-diligence stages. */
export const AUCTION_RA_STAGE_KEYS = ["rfi", "rfp", "rfq"] as const;
export type AuctionRaStageKey = (typeof AUCTION_RA_STAGE_KEYS)[number];
export const auctionRaStageKeyEnum = pgEnum(
  "auction_ra_stage_key",
  AUCTION_RA_STAGE_KEYS,
);

export const QUESTION_ANSWER_TYPES = [
  "short_text",
  "long_text",
  "number",
  "date",
  "single_choice",
  "multiple_choice",
  "file_upload",
] as const;
export type QuestionAnswerType = (typeof QUESTION_ANSWER_TYPES)[number];
export const questionAnswerTypeEnum = pgEnum(
  "question_answer_type",
  QUESTION_ANSWER_TYPES,
);

export const FILE_UPLOAD_TYPES = [
  "pdf",
  "word",
  "excel_csv",
  "images",
  "video",
  "zip",
  "text",
] as const;
export type FileUploadType = (typeof FILE_UPLOAD_TYPES)[number];
export const fileUploadTypeEnum = pgEnum("file_upload_type", FILE_UPLOAD_TYPES);

/** A reusable named set of due-diligence questions, scoped by stage(s) and client(s). */
export const questionTemplates = pgTable(
  "question_templates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    description: varchar("description", { length: 1000 }).notNull().default(""),
    /** Empty array = applicable to all stages. */
    stageKeys: auctionRaStageKeyEnum("stage_keys").array().notNull().default([]),
    /** Empty array = applicable to all clients. */
    clientIds: integer("client_ids").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (t) => [index("question_templates_is_active_idx").on(t.isActive)],
);

export const questionTemplateQuestions = pgTable(
  "question_template_questions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    templateId: integer("template_id")
      .notNull()
      .references(() => questionTemplates.id, { onDelete: "cascade" }),
    displayOrder: integer("display_order").notNull(),
    questionText: varchar("question_text", { length: 500 }).notNull(),
    answerType: questionAnswerTypeEnum("answer_type").notNull(),
    weight: integer("weight").notNull().default(1),
    required: boolean("required").notNull().default(true),
    /** Options for single_choice/multiple_choice answers. */
    options: text("options").array().notNull().default([]),
    fileUploadAllowedTypes: fileUploadTypeEnum("file_upload_allowed_types")
      .array()
      .notNull()
      .default([]),
    fileUploadMaxFileSizeMb: integer("file_upload_max_file_size_mb"),
  },
  (t) => [index("question_template_questions_template_id_idx").on(t.templateId)],
);

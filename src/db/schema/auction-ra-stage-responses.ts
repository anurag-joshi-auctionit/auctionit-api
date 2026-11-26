import {
  bigserial,
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { auctionRaStageQuestions, auctionRaStages } from "./auction-ra-stages.js";
import { auctionLots } from "./auction-lots.js";
import { users } from "./users.js";

export const AUCTION_RA_STAGE_RESPONSE_STATUSES = ["invited", "draft", "submitted"] as const;
export type AuctionRaStageResponseStatus =
  (typeof AUCTION_RA_STAGE_RESPONSE_STATUSES)[number];
export const auctionRaStageResponseStatusEnum = pgEnum(
  "auction_ra_stage_response_status",
  AUCTION_RA_STAGE_RESPONSE_STATUSES,
);

/**
 * One bidder's response within one stage. `isShortlisted` is informational
 * only — it does not read or write `auction_lot_bidder_maps`; attaching a
 * bidder to the auction stays a fully manual, unrelated action in the
 * existing Attach Bidders tab.
 */
export const auctionRaStageResponses = pgTable(
  "auction_ra_stage_responses",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    auctionRaStageId: integer("auction_ra_stage_id")
      .notNull()
      .references(() => auctionRaStages.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    status: auctionRaStageResponseStatusEnum("status").notNull().default("invited"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    /** Null = pending review. Informational only — see module docstring. */
    isShortlisted: boolean("is_shortlisted"),
    rejectionReason: varchar("rejection_reason", { length: 500 }),
    decidedBy: integer("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("auction_ra_stage_responses_stage_bidder_uidx").on(
      t.auctionRaStageId,
      t.bidderId,
    ),
  ],
);

export const auctionRaStageAnswers = pgTable(
  "auction_ra_stage_answers",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    responseId: integer("response_id")
      .notNull()
      .references(() => auctionRaStageResponses.id, { onDelete: "cascade" }),
    stageQuestionId: integer("stage_question_id")
      .notNull()
      .references(() => auctionRaStageQuestions.id),
    /** short_text / long_text / number / date answers. */
    valueText: text("value_text"),
    /** single_choice / multiple_choice answers. */
    valueChoices: text("value_choices").array(),
    /** file_upload answers — pointers into the generic `files` table. */
    fileRefs: jsonb("file_refs").$type<
      { fileId: number; fileName: string; sizeLabel: string }[] | null
    >(),
  },
  (t) => [
    uniqueIndex("auction_ra_stage_answers_response_question_uidx").on(
      t.responseId,
      t.stageQuestionId,
    ),
  ],
);

/** RFQ lot-level quote submitted by the bidder. */
export const auctionRaStageLotQuotes = pgTable(
  "auction_ra_stage_lot_quotes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    responseId: integer("response_id")
      .notNull()
      .references(() => auctionRaStageResponses.id, { onDelete: "cascade" }),
    lotId: integer("lot_id")
      .notNull()
      .references(() => auctionLots.id),
    amount: numeric("amount", { precision: 18, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("auction_ra_stage_lot_quotes_response_lot_uidx").on(t.responseId, t.lotId),
  ],
);

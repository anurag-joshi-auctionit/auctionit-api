import { sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { auctionLots } from "./auction-lots.js";
import { auctions } from "./auctions.js";
import { users } from "./users.js";

export const EMD_SETTLEMENT_JOB_KINDS = [
  "auction_closed",
  "lot_withdrawn",
  "legacy_cutover",
] as const;
export type EmdSettlementJobKind = (typeof EMD_SETTLEMENT_JOB_KINDS)[number];

export const EMD_SETTLEMENT_JOB_STATUSES = [
  "paused",
  "queued",
  "running",
  "done",
  "failed",
] as const;
export type EmdSettlementJobStatus =
  (typeof EMD_SETTLEMENT_JOB_STATUSES)[number];

export const emdSettlementJobKindEnum = pgEnum(
  "emd_settlement_job_kind",
  EMD_SETTLEMENT_JOB_KINDS,
);
export const emdSettlementJobStatusEnum = pgEnum(
  "emd_settlement_job_status",
  EMD_SETTLEMENT_JOB_STATUSES,
);

/**
 * Outbox of auction-level EMD settlement work (close, cancel, lot withdraw,
 * legacy cutover). Enqueued in the trigger's transaction and drained by the
 * worker tick with FOR UPDATE SKIP LOCKED.
 */
export const emdSettlementJobs = pgTable(
  "emd_settlement_jobs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    kind: emdSettlementJobKindEnum("kind").notNull(),
    lotId: integer("lot_id").references(() => auctionLots.id),
    status: emdSettlementJobStatusEnum("status").notNull().default("queued"),

    //worker bookkeeping
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),

    //totals written on completion
    biddersSettled: integer("bidders_settled"),
    amountReleased: numeric("amount_released", { precision: 18, scale: 2 }),
    amountWinning: numeric("amount_winning", { precision: 18, scale: 2 }),

    //audit
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("emd_settlement_jobs_status_next_attempt_at_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    index("emd_settlement_jobs_auction_id_idx").on(t.auctionId),
    uniqueIndex("emd_settlement_jobs_open_unique")
      .on(t.auctionId, t.kind, sql`coalesce(${t.lotId}, 0)`)
      .where(sql`${t.status} NOT IN ('done', 'failed')`),
  ],
);

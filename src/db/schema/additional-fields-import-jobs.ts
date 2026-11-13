import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { users } from "./users.js";

export const ADDITIONAL_FIELDS_IMPORT_JOB_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
] as const;
export type AdditionalFieldsImportJobStatus =
  (typeof ADDITIONAL_FIELDS_IMPORT_JOB_STATUSES)[number];

export const additionalFieldsImportJobStatusEnum = pgEnum(
  "additional_fields_import_job_status",
  ADDITIONAL_FIELDS_IMPORT_JOB_STATUSES,
);

/**
 * Outbox for background-processed additional-fields .xlsx imports. The route
 * uploads the file to R2 and enqueues a row here instead of parsing/writing
 * inline; drained by a FOR UPDATE SKIP LOCKED tick, same pattern as
 * emd_settlement_jobs.
 */
export const additionalFieldsImportJobs = pgTable(
  "additional_fields_import_jobs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    fileKey: varchar("file_key", { length: 500 }).notNull(),
    status: additionalFieldsImportJobStatusEnum("status").notNull().default("queued"),

    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),

    /** The resolved AdditionalFieldsImportResult once status = 'done'. */
    result: jsonb("result"),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("additional_fields_import_jobs_status_next_attempt_at_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    index("additional_fields_import_jobs_auction_id_idx").on(t.auctionId),
  ],
);

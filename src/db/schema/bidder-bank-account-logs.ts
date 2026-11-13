import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

/**
 * Request log for bidder-initiated bank account updates (open + closed).
 * Live profile (`bidder_bank_accounts`) is only written when isVerified becomes true.
 * isVerified: null = pending, true = accepted, false = rejected.
 */
export const bidderBankAccountLogs = pgTable(
  "bidder_bank_account_logs",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    bankAccount: varchar("bank_account", { length: 1000 }).notNull(),
    bankName: varchar("bank_name", { length: 1000 }).notNull(),
    bankIfsc: varchar("bank_ifsc", { length: 1000 }).notNull(),
    cancelledChequeFileName: varchar("cancelled_cheque_file_name", {
      length: 1000,
    }).notNull(),
    cancelledChequeS3Key: varchar("cancelled_cheque_s3_key", {
      length: 500,
    }).notNull(),
    isVerified: boolean("is_verified"),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    requestedBy: integer("requested_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", {
      withTimezone: true,
      mode: "string",
    }),
    reviewedBy: integer("reviewed_by").references(() => users.id),
    reviewRemark: varchar("review_remark", { length: 500 }),
  },
  (table) => [
    uniqueIndex("bidder_bank_account_logs_one_pending_per_bidder")
      .on(table.bidderId)
      .where(sql`${table.isVerified} IS NULL`),
    index("bidder_bank_account_logs_verified_requested_idx").on(
      table.isVerified,
      table.requestedAt,
    ),
    index("bidder_bank_account_logs_bidder_requested_idx").on(
      table.bidderId,
      table.requestedAt,
    ),
  ],
);

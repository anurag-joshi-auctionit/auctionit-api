import {
  boolean,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

export const bidderBankAccounts = pgTable(
  "bidder_bank_accounts",
  {
    id: integer("id").primaryKey().notNull(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    bankAccount: varchar("bank_account", { length: 1000 }),
    bankName: varchar("bank_name", { length: 1000 }),
    bankIfsc: varchar("bank_ifsc", { length: 1000 }),
    cancelledChequeFileName: varchar("cancelled_cheque_file_name", {
      length: 1000,
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
    isVerified: boolean("is_verified").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewedBy: integer("reviewed_by").references(() => users.id),
  },
  (table) => [uniqueIndex("bidder_bank_accounts_bidder_id_unique").on(table.bidderId)],
);

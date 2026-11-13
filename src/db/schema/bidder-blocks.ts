import {
  boolean,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { clients } from "./clients.js";
import { users } from "./users.js";

// Per-(client, bidder) block / unblock log. A bidder can be blocked for one
// client and active for another, and each pair accumulates a history of
// block/unblock events. Mirrors the legacy
// tbl_Data_Client_BidderComp_BlockLog table.
export const bidderBlockLogs = pgTable("bidder_block_logs", {
  id: integer("id").primaryKey().notNull(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clients.id),
  bidderId: integer("bidder_id")
    .notNull()
    .references(() => bidders.id),

  isBlocked: boolean("is_blocked").notNull().default(false),
  reason: varchar("reason", { length: 500 }),

  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by").references(() => users.id),
});

import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { clients } from "./clients.js";
import { users } from "./users.js";

// Per-(client, bidder) exemption / revoke log. A bidder can be exempted for
// one client and active for another, and each pair accumulates a history of
// exempt/revoke events. Current status = latest row per (clientId, bidderId).
export const bidderExemptionLogs = pgTable(
  "bidder_exemption_logs",
  {
    id: integer("id").primaryKey().notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),

    isExempted: boolean("is_exempted").notNull().default(false),
    reason: varchar("reason", { length: 500 }),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    index("bidder_exemption_logs_client_bidder_idx").on(
      table.clientId,
      table.bidderId,
    ),
  ],
);

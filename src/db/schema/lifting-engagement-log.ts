import {
  bigserial,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { auctionLots } from "./auction-lots.js";
import { clients } from "./clients.js";
import { liftingBidderDispositions } from "./lifting-dispositions.js";
import { users } from "./users.js";

/** Bidder CRM engagement history (call dispositions, follow-ups, bidder-reported qty). */
export const liftingEngagementLogs = pgTable(
  "lifting_engagement_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    lotId: integer("lot_id")
      .notNull()
      .references(() => auctionLots.id),
    dispositionId: integer("disposition_id")
      .notNull()
      .references(() => liftingBidderDispositions.id),
    notes: text("notes").notNull(),
    nextFollowup: timestamp("next_followup", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    liftedQtyBidder: numeric("lifted_qty_bidder", { precision: 18, scale: 3 }),
    loggedByUserId: integer("logged_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("lifting_engagement_logs_lot_created_idx").on(
      table.clientId,
      table.lotId,
      table.createdAt,
    ),
  ],
);

import {
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { auctions } from "./auctions.js";
import { bidders } from "./bidders.js";
import { auctionRaStageKeyEnum } from "./question-templates.js";
import { users } from "./users.js";

/**
 * A bidder invited into the RA Stages flow for an auction. `entryStage` is
 * always one of rfi/rfp/rfq — never the auction itself; stage invitations
 * are strictly about due diligence, not auction participation.
 */
export const auctionRaStageInvitedBidders = pgTable(
  "auction_ra_stage_invited_bidders",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    /** Null = joins at the earliest enabled stage. */
    entryStage: auctionRaStageKeyEnum("entry_stage"),
    invitedBy: integer("invited_by")
      .notNull()
      .references(() => users.id),
    invitedAt: timestamp("invited_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: "string" }),
    withdrawnBy: integer("withdrawn_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("auction_ra_stage_invited_bidders_active_uidx")
      .on(t.auctionId, t.bidderId)
      .where(sql`${t.isActive} = true`),
    index("auction_ra_stage_invited_bidders_auction_id_idx").on(t.auctionId),
  ],
);

import { jsonb, pgTable, timestamp, uuid, integer } from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { clients } from "./clients.js";
import { users } from "./users.js";

/**
 * Temporary lot-import staging sessions for fuzzy item review before commit.
 * Payload holds validated/resolved rows + match metadata (no Excel re-parse).
 */
export const auctionLotImportStagingSessions = pgTable(
  "auction_lot_import_staging_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    payload: jsonb("payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  },
);

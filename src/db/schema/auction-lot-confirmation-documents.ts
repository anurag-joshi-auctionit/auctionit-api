import {
  boolean,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { auctions } from "./auctions.js";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

/** One active letter per (auction, winning bidder) — overwrite on re-approval. */
export const auctionLotConfirmationDocuments = pgTable(
  "auction_lot_confirmation_documents",
  {
    id: integer("id").primaryKey().notNull(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    s3Key: varchar("s3_key", { length: 500 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true, mode: "string" }),
    emailSentBy: integer("email_sent_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("auction_lot_confirmation_documents_auction_bidder_uidx").on(
      table.auctionId,
      table.bidderId,
    ),
  ],
);

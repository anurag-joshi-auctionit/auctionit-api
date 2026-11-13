import {
  boolean,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { auctionDocumentTypes } from "./auction-document-types.js";
import { auctions } from "./auctions.js";
import { users } from "./users.js";

/** Seeded: Catalogue */
export const AUCTION_DOCUMENT_TYPE_CATALOGUE = 1;
/** Seeded: Terms & Conditions */
export const AUCTION_DOCUMENT_TYPE_TNC = 2;

export const auctionDocuments = pgTable(
  "auction_documents",
  {
    id: integer("id").primaryKey().notNull(),
    auctionId: integer("auction_id")
      .notNull()
      .references(() => auctions.id),
    documentTypeId: integer("document_type_id")
      .notNull()
      .references(() => auctionDocumentTypes.id),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    s3Key: varchar("s3_key", { length: 500 }).notNull().unique(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("auction_documents_auction_id_type_uidx").on(
      table.auctionId,
      table.documentTypeId,
    ),
  ],
);

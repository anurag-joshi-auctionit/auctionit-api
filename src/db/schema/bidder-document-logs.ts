import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { bidderDocumentTypes } from "./bidder-document-types.js";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

export const bidderDocumentLogs = pgTable(
  "bidder_document_logs",
  {
    id: integer("id").primaryKey().notNull(),
    bidderId: integer("bidder_id")
      .notNull()
      .references(() => bidders.id),
    documentTypeId: integer("document_type_id")
      .notNull()
      .references(() => bidderDocumentTypes.id),
    fileName: varchar("file_name", { length: 1000 }),
    s3Key: varchar("s3_key", { length: 500 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
    createdBy: integer("created_by").references(() => users.id),
  },
  (table) => [
    index("bidder_document_logs_bidder_id_idx").on(table.bidderId),
    index("bidder_document_logs_document_type_id_idx").on(
      table.documentTypeId,
    ),
    index("bidder_document_logs_bidder_type_created_idx").on(
      table.bidderId,
      table.documentTypeId,
      table.createdAt,
      table.id,
    ),
    index("bidder_document_logs_bidder_created_idx").on(
      table.bidderId,
      table.createdAt,
    ),
  ],
);

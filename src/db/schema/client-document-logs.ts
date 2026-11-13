import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { clientDocumentTypes } from "./client-document-types.js";
import { clients } from "./clients.js";
import { users } from "./users.js";

export const clientDocumentLogs = pgTable(
  "client_document_logs",
  {
    id: integer("id").primaryKey().notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    documentTypeId: integer("document_type_id")
      .notNull()
      .references(() => clientDocumentTypes.id),
    fileName: varchar("file_name", { length: 1000 }),
    s3Key: varchar("s3_key", { length: 500 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
    createdBy: integer("created_by").references(() => users.id),
  },
  (table) => [
    index("client_document_logs_client_id_idx").on(table.clientId),
    index("client_document_logs_document_type_id_idx").on(
      table.documentTypeId,
    ),
    index("client_document_logs_client_type_created_idx").on(
      table.clientId,
      table.documentTypeId,
      table.createdAt,
      table.id,
    ),
    index("client_document_logs_client_created_idx").on(
      table.clientId,
      table.createdAt,
    ),
  ],
);

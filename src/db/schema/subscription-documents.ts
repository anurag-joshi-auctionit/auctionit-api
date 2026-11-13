import {
  boolean,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { subscriptionDocumentTypes } from "./subscription-document-types.js";
import { subscriptions } from "./subscriptions.js";
import { users } from "./users.js";

/** One active file per (subscription, document type) — replace on reupload. */
export const subscriptionDocuments = pgTable(
  "subscription_documents",
  {
    id: integer("id").primaryKey().notNull(),
    subscriptionId: integer("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    documentTypeId: integer("document_type_id")
      .notNull()
      .references(() => subscriptionDocumentTypes.id),
    fileName: varchar("file_name", { length: 1000 }),
    s3Key: varchar("s3_key", { length: 500 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("subscription_documents_subscription_type_uidx").on(
      table.subscriptionId,
      table.documentTypeId,
    ),
  ],
);

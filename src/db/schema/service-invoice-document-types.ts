import {
  boolean,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const serviceInvoiceDocumentTypes = pgTable(
  "service_invoice_document_types",
  {
    id: integer("id").primaryKey().notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    fileNamePrefix: varchar("file_name_prefix", { length: 50 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
);

import {
  boolean,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { serviceInvoiceDocumentTypes } from "./service-invoice-document-types.js";
import { serviceInvoices } from "./service-invoices.js";
import { users } from "./users.js";

/** One active file per (service invoice, document type) — replace on reupload. */
export const serviceInvoiceDocuments = pgTable(
  "service_invoice_documents",
  {
    id: integer("id").primaryKey().notNull(),
    serviceInvoiceId: integer("service_invoice_id")
      .notNull()
      .references(() => serviceInvoices.id),
    documentTypeId: integer("document_type_id")
      .notNull()
      .references(() => serviceInvoiceDocumentTypes.id),
    fileName: varchar("file_name", { length: 1000 }),
    s3Key: varchar("s3_key", { length: 500 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("service_invoice_documents_invoice_type_uidx").on(
      table.serviceInvoiceId,
      table.documentTypeId,
    ),
  ],
);

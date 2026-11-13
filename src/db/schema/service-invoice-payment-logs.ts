import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import { serviceInvoices } from "./service-invoices.js";
import { users } from "./users.js";

/**
 * Payment receipt log for service invoices
 * (MSSQL `tbl_Data_ServiceInvoicePaymentDetails`).
 * Parent `service_invoices.paid_amount` / `unpaid_amount` /
 * `latest_payment_date` / `payment_status` are derived from active rows.
 */
export const serviceInvoicePaymentLogs = pgTable(
  "service_invoice_payment_logs",
  {
    id: integer("id").primaryKey().notNull(),
    serviceInvoiceId: integer("service_invoice_id")
      .notNull()
      .references(() => serviceInvoices.id),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 3 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    index("service_invoice_payment_logs_invoice_id_idx").on(
      table.serviceInvoiceId,
    ),
    index("service_invoice_payment_logs_invoice_paid_at_idx").on(
      table.serviceInvoiceId,
      table.paidAt,
    ),
    index("service_invoice_payment_logs_invoice_active_idx").on(
      table.serviceInvoiceId,
      table.isActive,
    ),
  ],
);

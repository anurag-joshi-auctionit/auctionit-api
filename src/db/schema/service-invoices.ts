import {
  date,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { clients, serviceFeeTypeEnum } from "./clients.js";
import { plantLocations } from "./plant-locations.js";
import { users } from "./users.js";

export const SERVICE_INVOICE_TYPES = ["auto", "manual"] as const;
export type ServiceInvoiceType = (typeof SERVICE_INVOICE_TYPES)[number];

export const SERVICE_INVOICE_STATUSES = [
  "draft",
  "requested",
  "generated",
  "recheck",
  "cancelled",
] as const;
export type ServiceInvoiceStatus = (typeof SERVICE_INVOICE_STATUSES)[number];

export const SERVICE_INVOICE_PAYMENT_STATUSES = [
  "unpaid",
  "partially_paid",
  "paid",
] as const;
export type ServiceInvoicePaymentStatus =
  (typeof SERVICE_INVOICE_PAYMENT_STATUSES)[number];

export const serviceInvoiceTypeEnum = pgEnum(
  "service_invoice_type",
  SERVICE_INVOICE_TYPES,
);

export const serviceInvoiceStatusEnum = pgEnum(
  "service_invoice_status",
  SERVICE_INVOICE_STATUSES,
);

export const serviceInvoicePaymentStatusEnum = pgEnum(
  "service_invoice_payment_status",
  SERVICE_INVOICE_PAYMENT_STATUSES,
);

export const serviceInvoices = pgTable(
  "service_invoices",
  {
    id: integer("id").primaryKey().notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id),
    plantLocationId: integer("plant_location_id")
      .notNull()
      .references(() => plantLocations.id),
    fromDate: timestamp("from_date", { withTimezone: true, mode: "string" }).notNull(),
    toDate: timestamp("to_date", { withTimezone: true, mode: "string" }).notNull(),
    type: serviceInvoiceTypeEnum("type").notNull().default("auto"),
    orderNumber: varchar("order_number", { length: 100 }),
    orderDate: timestamp("order_date", { withTimezone: true, mode: "string" }),
    gracePeriod: integer("grace_period"),
    totalQuantity: numeric("total_quantity", { precision: 18, scale: 3 })
      .notNull()
      .default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 3 })
      .notNull()
      .default("0"),
    serviceFeeType: serviceFeeTypeEnum("service_fee_type").notNull(),
    serviceFeeValue: numeric("service_fee_value", {
      precision: 18,
      scale: 4,
    }).notNull(),
    serviceFeeAmount: numeric("service_fee_amount", {
      precision: 18,
      scale: 3,
    }).notNull(),
    gstPercent: numeric("gst_percent", { precision: 9, scale: 2 })
      .notNull()
      .default("18"),
    gstAmount: numeric("gst_amount", { precision: 18, scale: 2 }).notNull(),
    grandTotal: numeric("grand_total", { precision: 18, scale: 3 }).notNull(),
    roundOff: numeric("round_off", { precision: 9, scale: 2 }),
    serviceChargeDescription: varchar("service_charge_description", {
      length: 3000,
    }),
    invoiceNumber: varchar("invoice_number", { length: 30 }),
    invoiceDate: date("invoice_date"),
    paymentDueDate: date("payment_due_date"),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 3 })
      .notNull()
      .default("0"),
    unpaidAmount: numeric("unpaid_amount", { precision: 18, scale: 3 })
      .notNull()
      .default("0"),
    latestPaymentDate: timestamp("latest_payment_date", { withTimezone: true, mode: "string" }),
    paymentStatus: serviceInvoicePaymentStatusEnum("payment_status")
      .notNull()
      .default("unpaid"),
    status: serviceInvoiceStatusEnum("status").notNull().default("draft"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }),
    requestedBy: integer("requested_by").references(() => users.id),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "string" }),
    generatedBy: integer("generated_by").references(() => users.id),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true, mode: "string" }),
    emailSentBy: integer("email_sent_by").references(() => users.id),
    recheckedAt: timestamp("rechecked_at", { withTimezone: true, mode: "string" }),
    recheckedBy: integer("rechecked_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "string" }),
    cancelledBy: integer("cancelled_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    createdBy: integer("created_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
    updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("service_invoices_invoice_number_uidx").on(table.invoiceNumber),
  ],
);

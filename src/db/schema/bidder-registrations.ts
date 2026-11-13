import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { users } from "./users.js";

// Mirrors the legacy MSSQL tbl_Data_UserReg: bidder/company self-registration
// (onboarding) records, including KYC document references, subscription /
// payment details and the admin approval workflow. Legacy country/state/city
// ids are kept as-is rather than resolved against the locations master because
// this is raw, user-submitted registration data.
export const bidderRegistrations = pgTable(
  "bidder_registrations",
  {
  //identity
  id: integer("id").primaryKey().notNull(),
  companyName: varchar("company_name", { length: 100 }),
  typeOfCompanyId: integer("type_of_company_id"),
  businessActivityId: integer("business_activity_id"),

  //address (legacy ids preserved from source)
  address: varchar("address", { length: 500 }),
  legacyCountryId: integer("legacy_country_id"),
  legacyStateId: integer("legacy_state_id"),
  city: varchar("city", { length: 100 }),
  legacyCityId: integer("legacy_city_id"),
  pincode: varchar("pincode", { length: 10 }),

  //contact
  phone: varchar("phone", { length: 20 }),
  secondaryPhone: varchar("secondary_phone", { length: 20 }),
  registeredEmail: varchar("registered_email", { length: 100 }),
  email: varchar("email", { length: 50 }),
  fullName: varchar("full_name", { length: 50 }),
  designation: varchar("designation", { length: 50 }),
  whatsappNumber: varchar("whatsapp_number", { length: 20 }),

  //tax
  gstin: varchar("gstin", { length: 50 }),
  invalidGst: integer("invalid_gst").default(0),
  pan: varchar("pan", { length: 50 }),

  //submitted-by details
  name: varchar("name", { length: 50 }),
  place: varchar("place", { length: 50 }),
  regDate: timestamp("reg_date", { withTimezone: true, mode: "string" }),
  designationPostedBy: varchar("designation_posted_by", { length: 50 }),

  //kyc document filenames
  panCardFileName: varchar("pan_card_file_name", { length: 200 }),
  proofOfAddressFileName: varchar("proof_of_address_file_name", { length: 200 }),
  gstinFileName: varchar("gstin_file_name", { length: 200 }),
  cancelledChequeFileName: varchar("cancelled_cheque_file_name", {
    length: 200,
  }),
  othersFileName: varchar("others_file_name", { length: 200 }),

  //interest selections (legacy comma-separated id lists)
  subCategoryIds: varchar("sub_category_ids", { length: 8000 }),
  clientIds: varchar("client_ids", { length: 500 }),

  //approval workflow
  adminStatus: integer("admin_status").default(0),
  verified: integer("verified"),
  bidderId: integer("bidder_id").references(() => bidders.id),
  remark: varchar("remark", { length: 8000 }),
  crmId: integer("crm_id"),
  isClosed: boolean("is_closed").default(false),

  //email tracking
  lastEmailSentDateTime: timestamp("last_email_sent_date_time", { withTimezone: true, mode: "string",
  }),
  emailSentCount: integer("email_sent_count"),
  isEmailSent: smallint("is_email_sent"),
  lastEmailSentDate: timestamp("last_email_sent_date", { withTimezone: true, mode: "string" }),
  isReviseSubsEmailSent: boolean("is_revise_subs_email_sent").default(false),
  finalSaveClickCount: integer("final_save_click_count"),

  //subscription
  subscriptionTypeId: integer("subscription_type_id"),
  bidderScopeId: integer("bidder_scope_id"),
  fromDate: date("from_date", { mode: "string" }),
  toDate: date("to_date", { mode: "string" }),
  subscriptionPrice: numeric("subscription_price", { precision: 18, scale: 2 }),
  gstAmount: numeric("gst_amount", { precision: 18, scale: 2 }),
  amount: numeric("amount", { precision: 18, scale: 3 }),

  //payment
  transactionId: varchar("transaction_id", { length: 100 }),
  paymentMode: integer("payment_mode"),
  paymentDate: timestamp("payment_date", { withTimezone: true, mode: "string" }),
  paymentStatus: varchar("payment_status", { length: 50 }),
  paymentRemarks: varchar("payment_remarks", { length: 2000 }),
  paymentUpdatedBy: integer("payment_updated_by").references(() => users.id),
  paymentUpdatedAt: timestamp("payment_updated_at", { withTimezone: true, mode: "string" }),

  //bank details
  accountNumber: varchar("account_number", { length: 100 }),
  bankName: varchar("bank_name", { length: 100 }),
  ifscCode: varchar("ifsc_code", { length: 100 }),

  //audit
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by").references(() => users.id),
  },
  (table) => [index("bidder_registrations_bidder_id_idx").on(table.bidderId)],
);

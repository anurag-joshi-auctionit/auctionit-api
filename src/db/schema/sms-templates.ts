import { integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const smsTemplates = pgTable("sms_templates", {
    //identity
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    //template
    code: varchar("code", { length: 50 }).notNull().unique(),
    // DLT-registered template id (19-digit identifier, stored as text).
    templateId: varchar("template_id", { length: 30 }).notNull().unique(),
    purpose: varchar("purpose", { length: 200 }).notNull(),
    messageFormat: varchar("message_format", { length: 500 }).notNull(),

    //audit
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const SMS_TEMPLATE_CODES = {
    otp: "otp",
    credentialsReset: "credentials_reset",
    registrationWelcome: "registration_welcome",
} as const;

export type SmsTemplateCode =
    (typeof SMS_TEMPLATE_CODES)[keyof typeof SMS_TEMPLATE_CODES];

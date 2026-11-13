import {
  boolean,
  integer,
  pgTable,
  timestamp,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { bidders } from "./bidders.js";
import { roles } from "./roles.js";

export const users = pgTable("users", {
  //identity
  id: integer("id").primaryKey().notNull(),
  userLoginName: varchar("user_login_name", { length: 50 }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  emailId: varchar("email_id", { length: 100 }),
  designation: varchar("designation", { length: 100 }),
  uniqueId: varchar("unique_id", { length: 50 }),

  //contact
  phoneNumber: varchar("phone_number", { length: 20 }),
  secondaryPhoneNumber: varchar("secondary_phone_number", { length: 20 }),
  whatsappNumber: varchar("whatsapp_number", { length: 20 }),
  whatsappSecNumber: varchar("whatsapp_sec_number", { length: 20 }),

  //credentials
  password: varchar("password", { length: 100 }).notNull(),
  previousPassword: varchar("previous_password", { length: 100 }),
  passwordChanged: boolean("password_changed").notNull().default(false),
  passwordAlgo: varchar("password_algo", { length: 16 })
    .notNull()
    .default("bcrypt"),
  mpin: varchar("mpin", { length: 100 }),
  // Legacy MSSQL columns (kept for seed); new forgot-password uses password_reset_* below.
  forgotPasswordOtp: varchar("forgot_password_otp", { length: 10 }),
  forgotPasswordOtpCreatedAt: timestamp("forgot_password_otp_created_at", { withTimezone: true, mode: "string",
  }),

  // Login 2FA challenge (cleared after successful verify or expiry)
  loginChallengeId: varchar("login_challenge_id", { length: 64 }),
  loginOtpHash: varchar("login_otp_hash", { length: 128 }),
  loginOtpExpiresAt: timestamp("login_otp_expires_at", {
    withTimezone: true,
    mode: "string",
  }),
  loginOtpAttempts: integer("login_otp_attempts").notNull().default(0),
  loginOtpChannel: varchar("login_otp_channel", { length: 16 }),

  // Forgot-password OTP + one-time reset token
  passwordResetChallengeId: varchar("password_reset_challenge_id", { length: 64 }),
  passwordResetOtpHash: varchar("password_reset_otp_hash", { length: 128 }),
  passwordResetOtpExpiresAt: timestamp("password_reset_otp_expires_at", {
    withTimezone: true,
    mode: "string",
  }),
  passwordResetOtpAttempts: integer("password_reset_otp_attempts")
    .notNull()
    .default(0),
  passwordResetOtpChannel: varchar("password_reset_otp_channel", { length: 16 }),
  passwordResetTokenHash: varchar("password_reset_token_hash", { length: 128 }),
  passwordResetTokenExpiresAt: timestamp("password_reset_token_expires_at", {
    withTimezone: true,
    mode: "string",
  }),

  //role
  roleId: integer("role_id")
    .notNull()
    .references(() => roles.id),

  // Owner flag (not a role) — gates granting ownership and elevated role governance
  isOwner: boolean("is_owner").notNull().default(false),

  //bidder link (strict 1:1 — at most one login user per bidder company)
  bidderId: integer("bidder_id")
    .unique()
    .references((): AnyPgColumn => bidders.id),

  //consent
  ndncAccepted: boolean("ndnc_accepted"),
  ndncUpdatedAt: timestamp("ndnc_updated_at", { withTimezone: true, mode: "string" }),

  //status flags
  isActive: boolean("is_active").notNull().default(true),
  isOldDesign: boolean("is_old_design").notNull().default(false),

  //session
  isLogin: boolean("is_login"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "string" }),
  lastLogoutAt: timestamp("last_logout_at", { withTimezone: true, mode: "string" }),
  sessionId: varchar("session_id", { length: 100 }),
  sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true, mode: "string",
    precision: 6,
  }),
  ipAddress: varchar("ip_address", { length: 50 }),
  token: varchar("token", { length: 100 }),
  tokenAt: timestamp("token_at", { withTimezone: true, mode: "string" }),

  //audit
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  createdBy: integer("created_by").notNull(),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "string" }),
  lastUpdatedBy: integer("last_updated_by"),
});

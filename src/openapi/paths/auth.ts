import { AuthValidationMessages } from "@auctionit/messages/auth";
import { BiddersValidationMessages } from "@auctionit/messages/bidders";
import { z } from "zod";
import { passwordComplexitySchema } from "../../lib/auth/password-rules.js";
import { bidderSignupSchema } from "../../lib/bidders/schemas.js";
import { OkBody, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  AuthFlowErrorBody,
  AuthForgotPasswordResult,
  AuthLoginResult,
  AuthMe,
  AuthOtpChallenge,
  AuthResetToken,
  AuthSession,
  AuthSignupLocations,
  AuthSignupMaterials,
  AuthUsernameAvailability,
} from "../responses/auth.js";

// Docs for src/routes/auth.ts — see docs/api/README.md.
const r = documentRouter("/auth");

// ---------------------------------------------------------------------------
// Request schemas recreated from routes/auth.ts (defined inline there).
// ---------------------------------------------------------------------------

/** routes/auth.ts `loginSchema`. */
const loginSchema = z.object({
  userLoginName: z.string().trim().min(1, AuthValidationMessages.USERNAME_REQUIRED),
  password: z.string().trim().min(1, AuthValidationMessages.PASSWORD_REQUIRED),
});

/** routes/auth.ts `otpSchema`. */
const otpSchema = z.object({
  challengeId: z.string().min(1),
  otp: z
    .string()
    .regex(/^\d{6}$/, AuthValidationMessages.OTP_INVALID_LENGTH)
    .describe("6-digit code from the email/SMS."),
});

/** routes/auth.ts `resendOtpSchema`. */
const resendOtpSchema = z.object({ challengeId: z.string().min(1) });

/**
 * routes/auth.ts `forgotPasswordSchema` (its superRefine is described in
 * prose: either `email` alone, or `userLoginName` + 10-digit `phone`).
 */
const forgotPasswordSchema = z.object({
  email: z.string().trim().optional().describe("Staff flow: account email. Send alone."),
  userLoginName: z.string().trim().optional().describe("Portal flow: username. Send with `phone`."),
  phone: z.string().trim().optional().describe("Portal flow: registered 10-digit mobile number."),
});

/** routes/auth.ts `changePasswordWithTokenSchema` (+ newPassword === confirmPassword refine). */
const changePasswordWithTokenSchema = z.object({
  resetToken: z.string().trim().min(1, AuthValidationMessages.RESET_TOKEN_REQUIRED),
  currentPassword: z
    .string()
    .trim()
    .min(1, AuthValidationMessages.CURRENT_PASSWORD_REQUIRED)
    .describe("The temporary password emailed after OTP verification."),
  newPassword: passwordComplexitySchema,
  confirmPassword: z.string().trim().min(1, AuthValidationMessages.CONFIRM_PASSWORD_REQUIRED),
});

/** routes/auth.ts `changePasswordSchema` (+ newPassword === confirmPassword refine). */
const changePasswordSchema = z.object({
  currentPassword: z.string().trim().min(1, AuthValidationMessages.CURRENT_PASSWORD_REQUIRED),
  newPassword: passwordComplexitySchema,
  confirmPassword: z.string().trim().min(1, AuthValidationMessages.CONFIRM_PASSWORD_REQUIRED),
});

/** Inline query schema of GET /signup/locations/search. */
const signupLocationsQuery = z.object({
  q: z.string().trim().optional().default("").describe("Matches city, state or country (substring). Empty returns no rows."),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

/** Inline query schema of GET /signup/username/available. */
const usernameAvailableQuery = z.object({
  userLoginName: z.string().trim().min(1, BiddersValidationMessages.USERNAME_REQUIRED).max(50),
});

/** 400s here are either a Zod validation body or an AuthError body with `code`. */
const Auth400 = z.union([ValidationErrorBody, AuthFlowErrorBody]);

const passwordRules =
  "`newPassword` must be 8–50 characters with an uppercase letter, a lowercase letter and a special character, " +
  "and must equal `confirmPassword`.";

const otpErrors = {
  401: {
    description:
      "`otp_invalid` (wrong code or unknown challenge), `otp_expired` (older than 15 minutes) or " +
      "`otp_locked` (5 wrong attempts; the challenge is cleared and the flow must restart).",
    schema: AuthFlowErrorBody,
  },
} as const;

const resendErrors = {
  401: { description: "`otp_invalid`: unknown or cleared challenge.", schema: AuthFlowErrorBody },
  400: {
    description: "`otp_missing_email` / `otp_missing_phone`: the account has no address for its channel. Or a validation error.",
    schema: Auth400,
  },
  429: { description: "`otp_resend_too_soon`: less than 2 minutes since the last OTP was sent.", schema: AuthFlowErrorBody },
  502: { description: "`otp_delivery_failed`: the email/SMS provider rejected the message.", schema: AuthFlowErrorBody },
} as const;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

r.post("/login", {
  summary: "Log in (step 1: password)",
  description:
    "Checks the username and password of an active user. Legacy MD5 password hashes are upgraded to bcrypt on success.\n\n" +
    "**2FA on (default, `AUTH_2FA_ENABLED`)**: a 6-digit OTP is generated and sent — by **SMS** for bidder/client portal " +
    "roles, by **email** for staff roles — and the response is `requiresOtp: true` with a `challengeId`. The OTP is valid " +
    "for 15 minutes and allows 5 attempts. Continue with `POST /auth/login/verify-otp`.\n\n" +
    "**2FA off**: the session is created immediately; the response carries `user` + `sessionToken` and sets the " +
    "`session_<appId>` cookie (see below).\n\n" +
    "**Session**: one session per user — a new login replaces the previous session token. The token lives 7 days and is " +
    "set as an httpOnly, `SameSite=Lax` cookie named `session_<appId>` (`appId` from the `X-App-Id` header, sanitised; " +
    "plain `session` when absent), `Secure` in production. Any later request may authenticate with that cookie or with " +
    "`Authorization: Bearer <sessionToken>`.\n\n" +
    "**Throttling**: failed passwords are counted per login name (10 per 15 min) and per client IP (50 per 15 min); " +
    "beyond that the endpoint answers 429 with a `Retry-After` header until the oldest failure ages out. A successful " +
    "login clears the login-name counter.",
  body: loginSchema,
  responses: {
    200: {
      description: "OTP challenge, or (2FA off) the logged-in user. Sets `Set-Cookie: session_<appId>=…` only when `requiresOtp` is false.",
      schema: AuthLoginResult,
    },
    401: { description: "`invalid_credentials`: unknown/inactive user or wrong password.", schema: AuthFlowErrorBody },
    400: {
      description:
        "Validation error, or `otp_missing_email` / `otp_missing_phone` when the account has no destination for its OTP channel.",
      schema: Auth400,
    },
    429: {
      description: "`login_rate_limited`: too many failed passwords for this login name or IP. See `Retry-After`.",
      schema: AuthFlowErrorBody,
    },
    502: { description: "`otp_delivery_failed`: the OTP email/SMS could not be sent.", schema: AuthFlowErrorBody },
  },
});

r.post("/login/verify-otp", {
  summary: "Log in (step 2: verify OTP)",
  description:
    "Verifies the login OTP for `challengeId`. On success creates the session (replacing any previous one), clears the " +
    "challenge, sets the httpOnly `session_<appId>` cookie (7 days) and returns the user plus `sessionToken`. Each wrong " +
    "code counts toward the 5-attempt limit.",
  body: otpSchema,
  responses: {
    200: { description: "Logged in. Response includes `Set-Cookie: session_<appId>=<token>`.", schema: AuthSession },
    ...otpErrors,
  },
});

r.post("/login/resend-otp", {
  summary: "Resend login OTP",
  description:
    "Sends a fresh login OTP for the same `challengeId` (same channel), resetting the 15-minute expiry and attempt count. " +
    "Allowed once the previous code is at least 2 minutes old.",
  body: resendOtpSchema,
  responses: { 200: AuthOtpChallenge, ...resendErrors },
});

// ---------------------------------------------------------------------------
// Forgot password: request → verify OTP (emails temp password) → change password
// ---------------------------------------------------------------------------

r.post("/forgot-password", {
  summary: "Forgot password (step 1: request OTP)",
  description:
    "Starts a password reset. Send **either** `email` (staff flow — OTP by email) **or** `userLoginName` + 10-digit " +
    "`phone` (portal flow — OTP by SMS for bidder/client roles), not both.\n\n" +
    "When no active user matches, responds `200 { sent: false }` (nothing is sent). Otherwise sends a 6-digit OTP " +
    "(15 minutes, 5 attempts) and returns the challenge. Next: `POST /auth/forgot-password/verify-otp`.",
  body: forgotPasswordSchema,
  responses: {
    200: AuthForgotPasswordResult,
    400: {
      description:
        "Validation error (missing/invalid email, or missing username/phone, or both flows mixed), or `otp_missing_email` / `otp_missing_phone`.",
      schema: Auth400,
    },
    502: { description: "`otp_delivery_failed`: the OTP could not be sent.", schema: AuthFlowErrorBody },
  },
});

r.post("/forgot-password/resend-otp", {
  summary: "Resend password-reset OTP",
  description:
    "Sends a fresh reset OTP for the same challenge on its original channel. Allowed once the previous code is at least 2 minutes old.",
  body: resendOtpSchema,
  responses: { 200: AuthOtpChallenge, ...resendErrors },
});

r.post("/forgot-password/verify-otp", {
  summary: "Forgot password (step 2: verify OTP)",
  description:
    "Verifies the reset OTP. On success the account's password is **replaced by a generated temporary password**, which " +
    "is **emailed** to the user's email address; existing sessions are ended (`passwordChanged` becomes false). Returns " +
    "a `resetToken` (15 minutes). Next: `POST /auth/forgot-password/change-password` with the token and the emailed " +
    "temporary password as `currentPassword`.",
  body: otpSchema,
  responses: {
    200: AuthResetToken,
    ...otpErrors,
    400: { description: "Validation error, or `otp_missing_email`: the account has no email for the temporary password.", schema: Auth400 },
    502: { description: "`otp_delivery_failed`: the temporary-password email could not be sent.", schema: AuthFlowErrorBody },
  },
});

r.post("/forgot-password/change-password", {
  summary: "Forgot password (step 3: set new password)",
  description:
    "Sets a new password using the `resetToken` and the emailed temporary password (`currentPassword`). Marks the " +
    "password as changed, ends any session and clears the reset/login challenges. Does **not** log the user in — " +
    "they log in again with the new password.\n\n" +
    passwordRules,
  body: changePasswordWithTokenSchema,
  responses: {
    200: OkBody,
    400: {
      description:
        "Validation error (e.g. password rules or mismatch), `current_password_invalid` (wrong temporary password) or " +
        "`password_same_as_current`.",
      schema: Auth400,
    },
    401: { description: "`password_reset_token_invalid`: unknown, used or expired reset token.", schema: AuthFlowErrorBody },
  },
});

// ---------------------------------------------------------------------------
// Logged-in account
// ---------------------------------------------------------------------------

r.post("/change-password", {
  summary: "Change own password",
  description:
    "Changes the logged-in user's password and sets `passwordChanged: true` (used to leave the forced-change screen " +
    "after a temporary password). The current session stays valid. Returns the refreshed user.\n\n" +
    passwordRules,
  body: changePasswordSchema,
  responses: {
    200: AuthMe,
    400: {
      description: "Validation error, `current_password_invalid` or `password_same_as_current` (field-bound `fieldErrors`).",
      schema: Auth400,
    },
  },
});

r.post("/logout", {
  summary: "Log out",
  description:
    "Ends the user's session server-side (all clients using the same token) and clears the `session_<appId>` cookie.",
  responses: { 204: { description: "Logged out. `Set-Cookie` clears `session_<appId>`." } },
});

r.get("/me", {
  summary: "Current user",
  description: "The logged-in user with role and enabled permission keys. Frontends call it on boot to restore the session.",
  responses: { 200: AuthMe },
});

// ---------------------------------------------------------------------------
// Public bidder signup
// ---------------------------------------------------------------------------

r.get("/signup/locations/search", {
  summary: "Search locations (signup form)",
  description: "Public location lookup for the bidder signup form. Substring match on city/state/country, ordered by city.",
  query: signupLocationsQuery,
  responses: { 200: AuthSignupLocations },
});

r.get("/signup/materials", {
  summary: "Materials (signup form)",
  description: "Public list of active leaf materials the bidder can declare interest in.",
  responses: { 200: AuthSignupMaterials },
});

r.get("/signup/username/available", {
  summary: "Check username availability",
  description: "Public check used while typing a username on the signup form.",
  query: usernameAvailableQuery,
  responses: { 200: AuthUsernameAvailability },
});

r.post("/signup", {
  summary: "Bidder self-registration",
  description:
    "Creates an **unverified** bidder company (awaiting admin approval) and an active bidder login. A generated " +
    "temporary password is **emailed** to `emailId`; the user then logs in through `/auth/login` and must change it. " +
    "Until an admin verifies the bidder, the account has limited access. No session is created.",
  body: bidderSignupSchema,
  responses: {
    201: OkBody,
    400: {
      description:
        "Validation error, or `locationId` does not exist. Username conflicts found alongside schema errors are merged into `fieldErrors`.",
      schema: ValidationErrorBody,
    },
    409: { description: "The body is valid but `userLoginName` is already taken.", schema: ValidationErrorBody },
  },
});

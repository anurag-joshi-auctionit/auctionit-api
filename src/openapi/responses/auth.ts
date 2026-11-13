import { z } from "../zod.js";

// Mirrors publicUser() / the inline res.json() bodies in routes/auth.ts and the
// OtpChallenge / AuthErrorCode types in services/auth.service.ts.

export const AuthRole = z
  .object({
    id: z.number().int(),
    code: z.string().openapi({ example: "admin" }),
    name: z.string(),
    isAdmin: z.boolean().openapi({ description: "Admin roles bypass the permission matrix." }),
  })
  .openapi("AuthRole");

export const AuthPublicUser = z
  .object({
    userId: z.number().int(),
    userLoginName: z.string(),
    name: z.string(),
    emailId: z.string().nullable(),
    bidderCompId: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Linked bidder company id for bidder-portal users, else null." }),
    bidderCompanyName: z.string().nullable(),
    bidderVan: z
      .string()
      .nullable()
      .openapi({ description: "Bidder's virtual account number (EMD deposits), when linked to a bidder." }),
    isOwner: z.boolean(),
    passwordChanged: z.boolean().openapi({
      description:
        "False while the user is still on a temporary (emailed) password; frontends force a password change.",
    }),
    permissions: z
      .array(z.string())
      .openapi({ description: "Enabled permission keys for the user's role.", example: ["module.clients", "clients.read"] }),
    role: AuthRole,
  })
  .openapi("AuthPublicUser");

const OtpChannel = z
  .enum(["email", "sms"])
  .openapi({ description: "`sms` for bidder/client portal roles, `email` for internal staff roles." });

const challengeFields = {
  challengeId: z.string().openapi({ description: "Opaque id to pass to the verify / resend endpoints." }),
  channel: OtpChannel,
  destinationHint: z
    .string()
    .openapi({ description: "Masked email or phone the OTP was sent to.", example: "ra****@example.com" }),
};

export const AuthOtpChallenge = z.object(challengeFields).openapi("AuthOtpChallenge");

const sessionToken = z.string().openapi({
  description:
    "Opaque session token (valid 7 days). Also set as the httpOnly `session_<appId>` cookie; send it as `Authorization: Bearer <token>` when not using cookies.",
});

export const AuthLoginResult = z
  .union([
    z
      .object({ requiresOtp: z.literal(true), ...challengeFields })
      .openapi("AuthLoginOtpRequired", { description: "2FA on: an OTP was sent; call `/auth/login/verify-otp`." }),
    z
      .object({ requiresOtp: z.literal(false), user: AuthPublicUser, sessionToken })
      .openapi("AuthLoginAuthenticated", { description: "2FA off: the session was created immediately." }),
  ])
  .openapi("AuthLoginResult");

export const AuthSession = z
  .object({ user: AuthPublicUser, sessionToken })
  .openapi("AuthSession");

export const AuthMe = z.object({ user: AuthPublicUser }).openapi("AuthMe");

export const AuthForgotPasswordResult = z
  .union([
    z
      .object({ sent: z.literal(true), ...challengeFields })
      .openapi("AuthForgotPasswordSent", { description: "A matching active user was found and an OTP was sent." }),
    z
      .object({ sent: z.literal(false) })
      .openapi("AuthForgotPasswordNotSent", { description: "No matching active user. Nothing was sent." }),
  ])
  .openapi("AuthForgotPasswordResult");

export const AuthResetToken = z
  .object({
    resetToken: z.string().openapi({
      description:
        "Single-use token (valid 15 minutes) for `/auth/forgot-password/change-password`, together with the temporary password that was just emailed.",
    }),
  })
  .openapi("AuthResetToken");

export const AuthErrorCode = z
  .enum([
    "invalid_credentials",
    "otp_invalid",
    "otp_expired",
    "otp_locked",
    "otp_missing_email",
    "otp_missing_phone",
    "otp_delivery_failed",
    "otp_resend_too_soon",
    "current_password_invalid",
    "password_same_as_current",
    "password_reset_token_invalid",
    "login_rate_limited",
  ])
  .openapi("AuthErrorCode");

/** authErrorResponse() in routes/auth.ts. */
export const AuthFlowErrorBody = z
  .object({
    error: z.string(),
    code: AuthErrorCode,
    fieldErrors: z
      .record(z.array(z.string()))
      .optional()
      .openapi({
        description:
          "Present for field-bound codes: `otp_*` (invalid/expired/locked) → `otp`, `current_password_invalid` → `currentPassword`, `password_same_as_current` → `newPassword`.",
      }),
  })
  .openapi("AuthFlowErrorBody");

export const AuthSignupLocations = z
  .object({
    items: z.array(
      z.object({ id: z.number().int(), city: z.string(), state: z.string(), country: z.string() }),
    ),
  })
  .openapi("AuthSignupLocations");

export const AuthSignupMaterials = z
  .object({
    items: z.array(
      z.object({
        id: z.number().int(),
        label: z.string(),
        breadcrumbLabel: z.string().openapi({ example: "Metals → Copper → Scrap" }),
      }),
    ),
  })
  .openapi("AuthSignupMaterials");

export const AuthUsernameAvailability = z
  .object({
    available: z.boolean(),
    message: z.string().optional().openapi({ description: "Set only when the username is taken." }),
  })
  .openapi("AuthUsernameAvailability");

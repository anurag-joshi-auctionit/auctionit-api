import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { bidders } from "../db/schema/bidders.js";
import { env } from "../env.js";
import { requireAuth } from "../auth/middleware.js";
import { sessionCookieName } from "../auth/session-cookie.js";
import { loadEnabledPermissionKeys } from "../auth/permissions.js";
import {
  fieldValidationErrorBody,
  zodValidationErrorBody,
} from "../lib/validation-error.js";
import {
  AuthError,
  SESSION_TTL_MS,
  authService,
  type AuthErrorCode,
  type AuthUser,
} from "../services/auth.service.js";
import { bidderSignupSchema } from "../lib/bidders/schemas.js";
import {
  BidderSignupError,
  bidderSignupErrorBody,
  bidderSignupService,
  collectSignupConflictFieldErrors,
} from "../services/bidder-signup.service.js";
import { locationsService } from "../services/locations.service.js";
import { materialsService } from "../services/materials.service.js";
import { isLoginAvailable } from "../services/users.service.js";
import {
  BiddersErrorMessages,
  BiddersValidationMessages,
} from "@auctionit/messages/bidders";
import {
  AuthErrorMessages,
  AuthValidationMessages,
} from "@auctionit/messages/auth";
import { passwordComplexitySchema } from "../lib/auth/password-rules.js";
import { loginThrottle } from "../lib/auth/login-throttle.js";

const router = Router();

const loginSchema = z.object({
  userLoginName: z
    .string()
    .trim()
    .min(1, AuthValidationMessages.USERNAME_REQUIRED),
  password: z
    .string()
    .trim()
    .min(1, AuthValidationMessages.PASSWORD_REQUIRED),
});

const otpSchema = z.object({
  challengeId: z.string().min(1),
  otp: z.string().regex(/^\d{6}$/, AuthValidationMessages.OTP_INVALID_LENGTH),
});

const resendOtpSchema = z.object({
  challengeId: z.string().min(1),
});

const forgotPasswordSchema = z
  .object({
    email: z.string().trim().optional(),
    userLoginName: z.string().trim().optional(),
    phone: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    const portal =
      data.userLoginName !== undefined || data.phone !== undefined;

    if (data.email !== undefined && portal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: AuthValidationMessages.EMAIL_REQUIRED,
        path: ["email"],
      });
      return;
    }

    if (data.email !== undefined) {
      if (!data.email) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: AuthValidationMessages.EMAIL_REQUIRED,
          path: ["email"],
        });
      } else if (!z.string().email().safeParse(data.email).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: AuthValidationMessages.INVALID_EMAIL,
          path: ["email"],
        });
      }
      return;
    }

    if (portal) {
      if (!data.userLoginName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: AuthValidationMessages.USERNAME_REQUIRED,
          path: ["userLoginName"],
        });
      }
      if (!data.phone) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: AuthValidationMessages.PHONE_REQUIRED,
          path: ["phone"],
        });
      } else if (!/^\d{10}$/.test(data.phone)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: AuthValidationMessages.INVALID_PHONE,
          path: ["phone"],
        });
      }
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: AuthValidationMessages.EMAIL_REQUIRED,
      path: ["email"],
    });
  });

const changePasswordWithTokenSchema = z
  .object({
    resetToken: z
      .string()
      .trim()
      .min(1, AuthValidationMessages.RESET_TOKEN_REQUIRED),
    currentPassword: z
      .string()
      .trim()
      .min(1, AuthValidationMessages.CURRENT_PASSWORD_REQUIRED),
    newPassword: passwordComplexitySchema,
    confirmPassword: z
      .string()
      .trim()
      .min(1, AuthValidationMessages.CONFIRM_PASSWORD_REQUIRED),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: AuthValidationMessages.PASSWORD_MISMATCH,
    path: ["confirmPassword"],
  });

const changePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .trim()
      .min(1, AuthValidationMessages.CURRENT_PASSWORD_REQUIRED),
    newPassword: passwordComplexitySchema,
    confirmPassword: z
      .string()
      .trim()
      .min(1, AuthValidationMessages.CONFIRM_PASSWORD_REQUIRED),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: AuthValidationMessages.PASSWORD_MISMATCH,
    path: ["confirmPassword"],
  });

const AUTH_ERROR_STATUS: Record<AuthErrorCode, number> = {
  invalid_credentials: 401,
  otp_invalid: 401,
  otp_expired: 401,
  otp_locked: 401,
  otp_missing_email: 400,
  otp_missing_phone: 400,
  otp_delivery_failed: 502,
  otp_resend_too_soon: 429,
  current_password_invalid: 400,
  password_same_as_current: 400,
  password_reset_token_invalid: 401,
};

const AUTH_ERROR_MESSAGE: Record<AuthErrorCode, string> = {
  invalid_credentials: AuthErrorMessages.INVALID_CREDENTIALS,
  otp_invalid: AuthErrorMessages.OTP_INVALID,
  otp_expired: AuthErrorMessages.OTP_EXPIRED,
  otp_locked: AuthErrorMessages.OTP_LOCKED,
  otp_missing_email: AuthErrorMessages.OTP_MISSING_EMAIL,
  otp_missing_phone: AuthErrorMessages.OTP_MISSING_PHONE,
  otp_delivery_failed: AuthErrorMessages.OTP_DELIVERY_FAILED,
  otp_resend_too_soon: AuthErrorMessages.OTP_RESEND_TOO_SOON,
  current_password_invalid: AuthErrorMessages.CURRENT_PASSWORD_INVALID,
  password_same_as_current: AuthErrorMessages.PASSWORD_SAME_AS_CURRENT,
  password_reset_token_invalid: AuthErrorMessages.PASSWORD_RESET_TOKEN_INVALID,
};

/** Map auth error codes onto form fields so clients can show FormMessage, not toast. */
const AUTH_ERROR_FIELD: Partial<Record<AuthErrorCode, string>> = {
  current_password_invalid: "currentPassword",
  password_same_as_current: "newPassword",
  otp_invalid: "otp",
  otp_expired: "otp",
  otp_locked: "otp",
};

function authErrorResponse(code: AuthErrorCode) {
  const message = AUTH_ERROR_MESSAGE[code];
  const field = AUTH_ERROR_FIELD[code];
  return {
    error: message,
    code,
    ...(field ? { fieldErrors: { [field]: [message] } } : {}),
  };
}

async function publicUser(u: AuthUser) {
  const permissions = await loadEnabledPermissionKeys(
    u.role.id,
    u.role.isAdmin,
  );
  let bidderCompanyName: string | null = null;
  let bidderVan: string | null = null;
  if (u.bidderId != null) {
    const [row] = await db
      .select({ companyName: bidders.companyName, van: bidders.van })
      .from(bidders)
      .where(eq(bidders.id, u.bidderId))
      .limit(1);
    bidderCompanyName = row?.companyName ?? null;
    bidderVan = row?.van ?? null;
  }
  return {
    userId: u.id,
    userLoginName: u.userLoginName,
    name: u.name,
    emailId: u.emailId,
    bidderCompId: u.bidderId ?? null,
    bidderCompanyName,
    bidderVan,
    isOwner: Boolean(u.isOwner),
    passwordChanged: Boolean(u.passwordChanged),
    permissions,
    role: {
      id: u.role.id,
      code: u.role.code,
      name: u.role.name,
      isAdmin: u.role.isAdmin,
    },
  };
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

router.post("/login", async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          AuthErrorMessages.GENERIC,
        ),
      );
    return;
  }
  const { userLoginName } = parsed.data;
  const retryAfterMs = loginThrottle.retryAfterMs(userLoginName, req.ip);
  if (retryAfterMs > 0) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    res.status(429).json({
      error: AuthErrorMessages.LOGIN_RATE_LIMITED,
      code: "login_rate_limited",
    });
    return;
  }
  try {
    const result = await authService.login(
      parsed.data.userLoginName,
      parsed.data.password,
    );
    loginThrottle.recordSuccess(userLoginName);
    if (result.status === "otp_required") {
      res.json({
        requiresOtp: true,
        challengeId: result.challenge.challengeId,
        channel: result.challenge.channel,
        destinationHint: result.challenge.destinationHint,
      });
      return;
    }
    res.cookie(sessionCookieName(req), result.token, cookieOptions());
    res.json({
      requiresOtp: false,
      user: await publicUser(result.user),
      sessionToken: result.token,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.code === "invalid_credentials") {
        loginThrottle.recordFailure(userLoginName, req.ip);
      }
      res
        .status(AUTH_ERROR_STATUS[e.code])
        .json(authErrorResponse(e.code));
      return;
    }
    next(e);
  }
});

router.post("/login/verify-otp", async (req, res, next) => {
  const parsed = otpSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          AuthErrorMessages.GENERIC,
        ),
      );
    return;
  }
  try {
    const { user, token } = await authService.verifyLoginOtp(
      parsed.data.challengeId,
      parsed.data.otp,
    );
    res.cookie(sessionCookieName(req), token, cookieOptions());
    res.json({ user: await publicUser(user), sessionToken: token });
  } catch (e) {
    if (e instanceof AuthError) {
      res
        .status(AUTH_ERROR_STATUS[e.code])
        .json(authErrorResponse(e.code));
      return;
    }
    next(e);
  }
});

router.post("/login/resend-otp", async (req, res, next) => {
  const parsed = resendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          AuthErrorMessages.GENERIC,
        ),
      );
    return;
  }
  try {
    const challenge = await authService.resendLoginOtp(parsed.data.challengeId);
    res.json({
      challengeId: challenge.challengeId,
      channel: challenge.channel,
      destinationHint: challenge.destinationHint,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      res
        .status(AUTH_ERROR_STATUS[e.code])
        .json(authErrorResponse(e.code));
      return;
    }
    next(e);
  }
});

router.post("/forgot-password", async (req, res, next) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          AuthErrorMessages.FORGOT_PASSWORD_FAILED,
        ),
      );
    return;
  }
  try {
    const identify =
      parsed.data.userLoginName && parsed.data.phone
        ? ({
            kind: "portal",
            userLoginName: parsed.data.userLoginName,
            phone: parsed.data.phone,
          } as const)
        : ({ kind: "email", email: parsed.data.email! } as const);
    const result = await authService.requestPasswordReset(identify);
    if (result.sent) {
      res.json({
        sent: true,
        challengeId: result.challenge.challengeId,
        channel: result.challenge.channel,
        destinationHint: result.challenge.destinationHint,
      });
      return;
    }
    res.json({ sent: false });
  } catch (e) {
    if (e instanceof AuthError) {
      res
        .status(AUTH_ERROR_STATUS[e.code])
        .json(authErrorResponse(e.code));
      return;
    }
    next(e);
  }
});

router.post("/forgot-password/resend-otp", async (req, res, next) => {
  const parsed = resendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          AuthErrorMessages.GENERIC,
        ),
      );
    return;
  }
  try {
    const challenge = await authService.resendPasswordResetOtp(
      parsed.data.challengeId,
    );
    res.json({
      challengeId: challenge.challengeId,
      channel: challenge.channel,
      destinationHint: challenge.destinationHint,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      res
        .status(AUTH_ERROR_STATUS[e.code])
        .json(authErrorResponse(e.code));
      return;
    }
    next(e);
  }
});

router.post("/forgot-password/verify-otp", async (req, res, next) => {
  const parsed = otpSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          AuthErrorMessages.GENERIC,
        ),
      );
    return;
  }
  try {
    const { resetToken } = await authService.verifyPasswordResetOtp(
      parsed.data.challengeId,
      parsed.data.otp,
    );
    res.json({ resetToken });
  } catch (e) {
    if (e instanceof AuthError) {
      res
        .status(AUTH_ERROR_STATUS[e.code])
        .json(authErrorResponse(e.code));
      return;
    }
    next(e);
  }
});

router.post("/forgot-password/change-password", async (req, res, next) => {
  const parsed = changePasswordWithTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          AuthErrorMessages.CHANGE_PASSWORD_FAILED,
        ),
      );
    return;
  }
  try {
    await authService.changePasswordWithToken(
      parsed.data.resetToken,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) {
      res
        .status(AUTH_ERROR_STATUS[e.code])
        .json(authErrorResponse(e.code));
      return;
    }
    next(e);
  }
});

router.post("/change-password", requireAuth, async (req, res, next) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          AuthErrorMessages.CHANGE_PASSWORD_FAILED,
        ),
      );
    return;
  }
  try {
    const user = await authService.changePassword(
      req.user!.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    res.json({ user: await publicUser(user) });
  } catch (e) {
    if (e instanceof AuthError) {
      res
        .status(AUTH_ERROR_STATUS[e.code])
        .json(authErrorResponse(e.code));
      return;
    }
    next(e);
  }
});

// Public catalog helpers for the bidder signup form (no auth required).
router.get("/signup/locations/search", async (req, res, next) => {
  const parsed = z
    .object({
      q: z.string().trim().optional().default(""),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const items = await locationsService.search(
      parsed.data.q,
      parsed.data.limit,
    );
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.get("/signup/materials", async (_req, res, next) => {
  try {
    const items = await materialsService.list(true);
    res.json({
      items: items
        .filter((m) => m.isLeaf && m.isActive)
        .map((m) => ({
          id: m.id,
          label: m.label,
          breadcrumbLabel: m.breadcrumbLabel,
        })),
    });
  } catch (e) {
    next(e);
  }
});

router.get("/signup/username/available", async (req, res, next) => {
  const parsed = z
    .object({
      userLoginName: z
        .string()
        .trim()
        .min(1, BiddersValidationMessages.USERNAME_REQUIRED)
        .max(50),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        zodValidationErrorBody(
          parsed.error,
          BiddersValidationMessages.VALIDATION_FAILED,
        ),
      );
    return;
  }
  try {
    const available = await isLoginAvailable(parsed.data.userLoginName);
    res.json({
      available,
      message: available
        ? undefined
        : BiddersErrorMessages.USERNAME_TAKEN,
    });
  } catch (e) {
    next(e);
  }
});

function mergeFieldErrors(
  ...maps: Array<Record<string, string[]> | undefined>
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [key, messages] of Object.entries(map)) {
      for (const message of messages) {
        if (!message) continue;
        const list = (merged[key] ??= []);
        if (!list.includes(message)) list.push(message);
      }
    }
  }
  return merged;
}

// Public bidder self-registration. Creates the (unapproved) bidder + login.
// Temporary password is emailed; client should redirect to /login.
router.post("/signup", async (req, res, next) => {
  const parsed = bidderSignupSchema.safeParse(req.body);
  try {
    const conflicts = await collectSignupConflictFieldErrors(req.body);
    if (!parsed.success || Object.keys(conflicts).length > 0) {
      const fieldErrors = mergeFieldErrors(
        parsed.success
          ? undefined
          : zodValidationErrorBody(parsed.error).fieldErrors,
        conflicts,
      );
      res.status(parsed.success ? 409 : 400).json(
        fieldValidationErrorBody(
          fieldErrors,
          BiddersValidationMessages.VALIDATION_FAILED,
        ),
      );
      return;
    }
    await bidderSignupService.signup(parsed.data);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e instanceof BidderSignupError) {
      const status =
        e.fieldErrors && e.code !== "LOCATION_NOT_FOUND" ? 409 : 400;
      res.status(status).json(bidderSignupErrorBody(e));
      return;
    }
    next(e);
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  if (req.user) await authService.logout(req.user.id);
  res.clearCookie(sessionCookieName(req), { path: "/" });
  res.status(204).end();
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    res.json({ user: await publicUser(req.user!) });
  } catch (e) {
    next(e);
  }
});

export default router;

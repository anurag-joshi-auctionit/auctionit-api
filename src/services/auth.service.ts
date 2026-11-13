import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  ROLE_CODES,
  bidders,
  clients,
  isAdminAppRoleCode,
  roles,
  SMS_TEMPLATE_CODES,
  smsTemplates,
  userClients,
  users,
} from "../db/schema/index.js";
import {
  hashPassword,
  hashPasswordForStorage,
  verifyPassword,
  type PasswordAlgo,
} from "../auth/hash.js";
import { env } from "../env.js";
import { formatUtcNow } from "@auctionit/lib/date";
import { sendMail } from "../lib/email.js";
import { sendSms } from "../lib/sms.js";
import {
  buildAuthOtpEmailHtml,
  buildAuthOtpEmailSubject,
  buildTempPasswordEmailHtml,
  buildTempPasswordEmailSubject,
  type TempPasswordEmailReason,
} from "../lib/auth/password-email-templates.js";
import { generateTemporaryPassword } from "../lib/auth/password-rules.js";
import { renderMessage } from "./sms.service.js";

export type AuthUserRow = typeof users.$inferSelect;
export type AuthRole = typeof roles.$inferSelect;
export type AuthUser = AuthUserRow & { role: AuthRole };

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_OTP_TTL_MS = 15 * 60 * 1000;
export const LOGIN_OTP_MAX_ATTEMPTS = 5;
export const LOGIN_OTP_LENGTH = 6;
export const OTP_RESEND_COOLDOWN_MS = 2 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

export type AuthErrorCode =
  | "invalid_credentials"
  | "otp_invalid"
  | "otp_expired"
  | "otp_locked"
  | "otp_missing_email"
  | "otp_missing_phone"
  | "otp_delivery_failed"
  | "otp_resend_too_soon"
  | "current_password_invalid"
  | "password_same_as_current"
  | "password_reset_token_invalid";

export class AuthError extends Error {
  constructor(public code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
  }
}

export type OtpChannel = "email" | "sms";

export type OtpChallenge = {
  challengeId: string;
  channel: OtpChannel;
  destinationHint: string;
};

export type LoginResult =
  | { status: "authenticated"; user: AuthUser; token: string; expiresAt: Date }
  | { status: "otp_required"; challenge: OtpChallenge };

export type ForgotPasswordRequestResult =
  | { sent: true; challenge: OtpChallenge }
  | { sent: false };

export type ForgotPasswordIdentify =
  | { kind: "email"; email: string }
  | { kind: "portal"; userLoginName: string; phone: string };

function narrowAlgo(value: string): PasswordAlgo {
  return value === "bcrypt" || value === "bcrypt_md5" ? value : "md5";
}

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp, "utf8").digest("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function generateOtp(): string {
  const max = 10 ** LOGIN_OTP_LENGTH;
  const min = 10 ** (LOGIN_OTP_LENGTH - 1);
  return String(randomInt(min, max));
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

/** Portal users (bidder/client) get SMS; internal/admin-app users get email. */
export function otpChannelForRole(code: string): OtpChannel {
  if (
    code === ROLE_CODES.bidder ||
    code === ROLE_CODES.client ||
    code === ROLE_CODES.clientLimited
  ) {
    return "sms";
  }
  return "email";
}

async function loadUserWithRole(
  whereClause: ReturnType<typeof eq> | ReturnType<typeof and>,
): Promise<AuthUser | null> {
  const [row] = await db
    .select({ user: users, role: roles })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(whereClause)
    .limit(1);
  if (!row) return null;
  return { ...row.user, role: row.role };
}

export class AuthService {
  async login(identifier: string, password: string): Promise<LoginResult> {
    const user = await this.verifyCredentials(identifier, password);

    if (!env.AUTH_2FA_ENABLED) {
      const token = this.generateSessionToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await this.setSession(user.id, token, expiresAt);
      await this.clearLoginChallenge(user.id);
      return { status: "authenticated", user, token, expiresAt };
    }

    const challenge = await this.createAndSendLoginOtp(user);
    return { status: "otp_required", challenge };
  }

  async verifyLoginOtp(
    challengeId: string,
    otp: string,
  ): Promise<{ user: AuthUser; token: string; expiresAt: Date }> {
    const trimmedChallenge = challengeId.trim();
    const trimmedOtp = otp.trim();
    if (!trimmedChallenge || !/^\d{6}$/.test(trimmedOtp)) {
      throw new AuthError("otp_invalid");
    }

    const user = await loadUserWithRole(
      eq(users.loginChallengeId, trimmedChallenge),
    );
    if (!user || !user.isActive) throw new AuthError("otp_invalid");

    if (
      !user.loginOtpExpiresAt ||
      new Date(user.loginOtpExpiresAt).getTime() <= Date.now()
    ) {
      await this.clearLoginChallenge(user.id);
      throw new AuthError("otp_expired");
    }

    if ((user.loginOtpAttempts ?? 0) >= LOGIN_OTP_MAX_ATTEMPTS) {
      await this.clearLoginChallenge(user.id);
      throw new AuthError("otp_locked");
    }

    if (!user.loginOtpHash || user.loginOtpHash !== hashOtp(trimmedOtp)) {
      const attempts = (user.loginOtpAttempts ?? 0) + 1;
      await db
        .update(users)
        .set({ loginOtpAttempts: attempts })
        .where(eq(users.id, user.id));
      if (attempts >= LOGIN_OTP_MAX_ATTEMPTS) {
        await this.clearLoginChallenge(user.id);
        throw new AuthError("otp_locked");
      }
      throw new AuthError("otp_invalid");
    }

    const token = this.generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.setSession(user.id, token, expiresAt);
    await this.clearLoginChallenge(user.id);

    return { user, token, expiresAt };
  }

  async resendLoginOtp(challengeId: string): Promise<OtpChallenge> {
    const trimmedChallenge = challengeId.trim();
    if (!trimmedChallenge) throw new AuthError("otp_invalid");

    const user = await loadUserWithRole(
      eq(users.loginChallengeId, trimmedChallenge),
    );
    if (!user || !user.isActive) throw new AuthError("otp_invalid");

    this.assertOtpResendAllowed(user.loginOtpExpiresAt);
    return this.createAndSendLoginOtp(user, trimmedChallenge);
  }

  async requestPasswordReset(
    identify: ForgotPasswordIdentify,
  ): Promise<ForgotPasswordRequestResult> {
    const user =
      identify.kind === "email"
        ? await this.findActiveUserByEmail(identify.email)
        : await this.findActivePortalUserByLoginAndPhone(
            identify.userLoginName,
            identify.phone,
          );

    if (!user) return { sent: false };

    const otpChannel =
      identify.kind === "email" ? "email" : otpChannelForRole(user.role.code);

    try {
      const challenge = await this.createAndSendPasswordResetOtp(
        user,
        otpChannel,
      );
      return { sent: true, challenge };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError("otp_delivery_failed");
    }
  }

  async resendPasswordResetOtp(challengeId: string): Promise<OtpChallenge> {
    const trimmedChallenge = challengeId.trim();
    if (!trimmedChallenge) throw new AuthError("otp_invalid");

    const user = await loadUserWithRole(
      eq(users.passwordResetChallengeId, trimmedChallenge),
    );
    if (!user || !user.isActive) throw new AuthError("otp_invalid");

    this.assertOtpResendAllowed(user.passwordResetOtpExpiresAt);
    const channel =
      (user.passwordResetOtpChannel as OtpChannel | null) ??
      otpChannelForRole(user.role.code);
    return this.createAndSendPasswordResetOtp(
      user,
      channel,
      trimmedChallenge,
    );
  }

  async verifyPasswordResetOtp(
    challengeId: string,
    otp: string,
  ): Promise<{ resetToken: string }> {
    const trimmedChallenge = challengeId.trim();
    const trimmedOtp = otp.trim();
    if (!trimmedChallenge || !/^\d{6}$/.test(trimmedOtp)) {
      throw new AuthError("otp_invalid");
    }

    const user = await loadUserWithRole(
      eq(users.passwordResetChallengeId, trimmedChallenge),
    );
    if (!user || !user.isActive) throw new AuthError("otp_invalid");

    if (
      !user.passwordResetOtpExpiresAt ||
      new Date(user.passwordResetOtpExpiresAt).getTime() <= Date.now()
    ) {
      await this.clearPasswordResetChallenge(user.id);
      throw new AuthError("otp_expired");
    }

    if ((user.passwordResetOtpAttempts ?? 0) >= LOGIN_OTP_MAX_ATTEMPTS) {
      await this.clearPasswordResetChallenge(user.id);
      throw new AuthError("otp_locked");
    }

    if (
      !user.passwordResetOtpHash ||
      user.passwordResetOtpHash !== hashOtp(trimmedOtp)
    ) {
      const attempts = (user.passwordResetOtpAttempts ?? 0) + 1;
      await db
        .update(users)
        .set({ passwordResetOtpAttempts: attempts })
        .where(eq(users.id, user.id));
      if (attempts >= LOGIN_OTP_MAX_ATTEMPTS) {
        await this.clearPasswordResetChallenge(user.id);
        throw new AuthError("otp_locked");
      }
      throw new AuthError("otp_invalid");
    }

    const email = user.emailId?.trim();
    if (!email) throw new AuthError("otp_missing_email");

    const temporaryPassword = generateTemporaryPassword();
    const { hash, algo } = await hashPasswordForStorage(temporaryPassword);
    const resetToken = randomBytes(32).toString("base64url");
    const tokenExpiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);

    await db
      .update(users)
      .set({
        previousPassword: user.password,
        password: hash,
        passwordAlgo: algo,
        passwordChanged: false,
        sessionId: null,
        sessionExpiresAt: null,
        isLogin: false,
        passwordResetOtpHash: null,
        passwordResetOtpExpiresAt: null,
        passwordResetOtpAttempts: 0,
        passwordResetTokenHash: hashToken(resetToken),
        passwordResetTokenExpiresAt: formatUtcNow(tokenExpiresAt),
      })
      .where(eq(users.id, user.id));

    await this.clearLoginChallenge(user.id);

    try {
      await this.sendTemporaryPasswordEmail(
        user,
        temporaryPassword,
        "forgot_password",
      );
    } catch {
      throw new AuthError("otp_delivery_failed");
    }

    return { resetToken };
  }

  async changePasswordWithToken(
    resetToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const trimmedToken = resetToken.trim();
    if (!trimmedToken) throw new AuthError("password_reset_token_invalid");

    const user = await loadUserWithRole(
      eq(users.passwordResetTokenHash, hashToken(trimmedToken)),
    );
    if (!user || !user.isActive) {
      throw new AuthError("password_reset_token_invalid");
    }

    if (
      !user.passwordResetTokenExpiresAt ||
      new Date(user.passwordResetTokenExpiresAt).getTime() <= Date.now()
    ) {
      await this.clearPasswordResetChallenge(user.id);
      throw new AuthError("password_reset_token_invalid");
    }

    const trimmedCurrent = currentPassword.trim();
    const trimmedNew = newPassword.trim();

    const ok = await verifyPassword(
      trimmedCurrent,
      user.password,
      narrowAlgo(user.passwordAlgo),
    );
    if (!ok) throw new AuthError("current_password_invalid");

    if (trimmedCurrent === trimmedNew) {
      throw new AuthError("password_same_as_current");
    }

    const { hash, algo } = await hashPasswordForStorage(trimmedNew);
    await db
      .update(users)
      .set({
        previousPassword: user.password,
        password: hash,
        passwordAlgo: algo,
        passwordChanged: true,
        lastUpdatedAt: formatUtcNow(),
        lastUpdatedBy: user.id,
        sessionId: null,
        sessionExpiresAt: null,
        isLogin: false,
      })
      .where(eq(users.id, user.id));

    await this.clearPasswordResetChallenge(user.id);
    await this.clearLoginChallenge(user.id);
  }

  /**
   * Generate a temp password, persist it, and email credentials.
   * Used by admin reset (`admin_reset`) and self-service signup (`user_created`).
   * Admin New User does not call this — use Reset Password to send credentials.
   */
  async issueTemporaryPasswordAndEmail(
    userId: number,
    actingUserId: number,
    reason: TempPasswordEmailReason,
  ): Promise<void> {
    const user = await loadUserWithRole(eq(users.id, userId));
    if (!user) {
      throw new AuthError("invalid_credentials");
    }
    const email = user.emailId?.trim();
    if (!email) throw new AuthError("otp_missing_email");

    const temporaryPassword = generateTemporaryPassword();
    const { hash, algo } = await hashPasswordForStorage(temporaryPassword);
    await db
      .update(users)
      .set({
        previousPassword: user.password,
        password: hash,
        passwordAlgo: algo,
        passwordChanged: false,
        lastUpdatedAt: formatUtcNow(),
        lastUpdatedBy: actingUserId,
        sessionId: null,
        sessionExpiresAt: null,
        isLogin: false,
      })
      .where(eq(users.id, userId));

    await this.clearLoginChallenge(userId);
    await this.clearPasswordResetChallenge(userId);

    try {
      await this.sendTemporaryPasswordEmail(user, temporaryPassword, reason);
    } catch {
      throw new AuthError("otp_delivery_failed");
    }
  }

  async applyAdminPasswordReset(
    userId: number,
    actingUserId: number,
  ): Promise<void> {
    await this.issueTemporaryPasswordAndEmail(
      userId,
      actingUserId,
      "admin_reset",
    );
  }

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthUser> {
    const user = await loadUserWithRole(eq(users.id, userId));
    if (!user || !user.isActive) throw new AuthError("invalid_credentials");

    const trimmedCurrent = currentPassword.trim();
    const trimmedNew = newPassword.trim();

    const ok = await verifyPassword(
      trimmedCurrent,
      user.password,
      narrowAlgo(user.passwordAlgo),
    );
    if (!ok) throw new AuthError("current_password_invalid");

    if (trimmedCurrent === trimmedNew) {
      throw new AuthError("password_same_as_current");
    }

    const { hash, algo } = await hashPasswordForStorage(trimmedNew);
    await db
      .update(users)
      .set({
        previousPassword: user.password,
        password: hash,
        passwordAlgo: algo,
        passwordChanged: true,
        lastUpdatedAt: formatUtcNow(),
        lastUpdatedBy: userId,
      })
      .where(eq(users.id, userId));

    await this.clearLoginChallenge(userId);
    await this.clearPasswordResetChallenge(userId);

    return {
      ...user,
      password: hash,
      passwordAlgo: algo,
      passwordChanged: true,
    };
  }

  async logout(userId: number): Promise<void> {
    await db
      .update(users)
      .set({
        sessionId: null,
        sessionExpiresAt: null,
        lastLogoutAt: formatUtcNow(),
        isLogin: false,
      })
      .where(eq(users.id, userId));
  }

  async findBySession(token: string): Promise<AuthUser | null> {
    return loadUserWithRole(
      and(
        eq(users.sessionId, token),
        gt(users.sessionExpiresAt, formatUtcNow()),
        eq(users.isActive, true),
      )!,
    );
  }

  private async findActiveUserByEmail(email: string): Promise<AuthUser | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const user = await loadUserWithRole(
      sql`lower(trim(coalesce(${users.emailId}, ''))) = ${normalized}` as never,
    );
    if (!user || !user.isActive) return null;
    return user;
  }

  /**
   * Forgot-password (app + admin): username + phone must match the same active user.
   * Bidders need a real bidder company. Clients need an active client link.
   * Admin-app staff (incl. accounts) are eligible without entity links.
   */
  private async findActivePortalUserByLoginAndPhone(
    userLoginName: string,
    phone: string,
  ): Promise<AuthUser | null> {
    const login = userLoginName.trim();
    const digits = normalizePhoneDigits(phone);
    if (!login || digits.length !== 10) return null;

    const user = await loadUserWithRole(
      and(
        eq(users.userLoginName, login),
        sql`right(regexp_replace(coalesce(${users.phoneNumber}, ''), '[^0-9]', '', 'g'), 10) = ${digits}`,
      )!,
    );
    if (!user || !user.isActive) return null;
    if (!(await this.isEligiblePortalResetUser(user))) return null;
    return user;
  }

  private async isEligiblePortalResetUser(user: AuthUser): Promise<boolean> {
    if (user.role.code === ROLE_CODES.bidder) {
      if (user.bidderId == null) return false;
      const [bidder] = await db
        .select({ id: bidders.id })
        .from(bidders)
        .where(eq(bidders.id, user.bidderId))
        .limit(1);
      return bidder != null;
    }
    if (
      user.role.code === ROLE_CODES.client ||
      user.role.code === ROLE_CODES.clientLimited
    ) {
      const [link] = await db
        .select({ clientId: userClients.clientId })
        .from(userClients)
        .innerJoin(clients, eq(clients.id, userClients.clientId))
        .where(
          and(eq(userClients.userId, user.id), eq(userClients.isActive, true))!,
        )
        .limit(1);
      return link != null;
    }
    // Admin SPA staff: admin/kam/custom isAdmin roles, plus accounts.
    if (
      isAdminAppRoleCode(user.role.code, user.role.isAdmin) ||
      user.role.code === ROLE_CODES.account
    ) {
      return true;
    }
    return false;
  }

  private async verifyCredentials(
    identifier: string,
    password: string,
  ): Promise<AuthUser> {
    const trimmed = identifier.trim();
    const trimmedPassword = password.trim();
    const user = trimmed
      ? await loadUserWithRole(eq(users.userLoginName, trimmed))
      : null;
    if (!user || !user.isActive) throw new AuthError("invalid_credentials");

    const ok = await verifyPassword(
      trimmedPassword,
      user.password,
      narrowAlgo(user.passwordAlgo),
    );
    if (!ok) throw new AuthError("invalid_credentials");

    // Legacy md5 / wrapped bcrypt_md5 rows become plain bcrypt on first login.
    if (user.passwordAlgo !== "bcrypt") {
      const upgraded = await hashPassword(trimmedPassword);
      await db
        .update(users)
        .set({ password: upgraded, passwordAlgo: "bcrypt" })
        .where(eq(users.id, user.id));
      user.password = upgraded;
      user.passwordAlgo = "bcrypt";
    }

    return user;
  }

  private assertOtpResendAllowed(expiresAt: string | null): void {
    if (!expiresAt) return;
    const expiresMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expiresMs)) return;
    const sentAt = expiresMs - LOGIN_OTP_TTL_MS;
    if (Date.now() - sentAt < OTP_RESEND_COOLDOWN_MS) {
      throw new AuthError("otp_resend_too_soon");
    }
  }

  private async createAndSendLoginOtp(
    user: AuthUser,
    existingChallengeId?: string,
  ): Promise<OtpChallenge> {
    return this.createAndSendOtp(
      user,
      "login",
      otpChannelForRole(user.role.code),
      existingChallengeId,
    );
  }

  private async createAndSendPasswordResetOtp(
    user: AuthUser,
    channel: OtpChannel,
    existingChallengeId?: string,
  ): Promise<OtpChallenge> {
    return this.createAndSendOtp(
      user,
      "password_reset",
      channel,
      existingChallengeId,
    );
  }

  private async createAndSendOtp(
    user: AuthUser,
    purpose: "login" | "password_reset",
    channel: OtpChannel,
    existingChallengeId?: string,
  ): Promise<OtpChallenge> {
    if (channel === "email") {
      if (!user.emailId?.trim()) throw new AuthError("otp_missing_email");
    } else if (!user.phoneNumber?.trim()) {
      throw new AuthError("otp_missing_phone");
    }

    const otp = generateOtp();
    const challengeId =
      existingChallengeId ?? randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + LOGIN_OTP_TTL_MS);

    if (purpose === "login") {
      await db
        .update(users)
        .set({
          loginChallengeId: challengeId,
          loginOtpHash: hashOtp(otp),
          loginOtpExpiresAt: formatUtcNow(expiresAt),
          loginOtpAttempts: 0,
          loginOtpChannel: channel,
        })
        .where(eq(users.id, user.id));
    } else {
      await db
        .update(users)
        .set({
          passwordResetChallengeId: challengeId,
          passwordResetOtpHash: hashOtp(otp),
          passwordResetOtpExpiresAt: formatUtcNow(expiresAt),
          passwordResetOtpAttempts: 0,
          passwordResetOtpChannel: channel,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        })
        .where(eq(users.id, user.id));
    }

    const smsPurpose =
      purpose === "login" ? "login verification" : "resetting your password";

    try {
      if (channel === "email") {
        await this.sendOtpEmail(user.emailId!.trim(), otp);
        return {
          challengeId,
          channel,
          destinationHint: maskEmail(user.emailId!.trim()),
        };
      }

      await this.sendOtpSms(user.phoneNumber!.trim(), otp, smsPurpose);
      return {
        challengeId,
        channel,
        destinationHint: maskPhone(user.phoneNumber!.trim()),
      };
    } catch {
      if (purpose === "login") await this.clearLoginChallenge(user.id);
      else await this.clearPasswordResetChallenge(user.id);
      throw new AuthError("otp_delivery_failed");
    }
  }

  private async sendOtpEmail(to: string, otp: string): Promise<void> {
    await sendMail({
      to,
      subject: buildAuthOtpEmailSubject(),
      html: buildAuthOtpEmailHtml(otp),
    });
  }

  /**
   * Emails username + temporary password (create / admin reset / forgot).
   * Throws AuthError when email is missing or delivery fails.
   */
  async sendCredentialsEmail(
    user: {
      name: string;
      emailId: string | null;
      userLoginName: string;
    },
    temporaryPassword: string,
    reason: TempPasswordEmailReason,
  ): Promise<void> {
    const to = user.emailId?.trim();
    if (!to) throw new AuthError("otp_missing_email");
    try {
      await sendMail({
        to,
        subject: buildTempPasswordEmailSubject(reason),
        html: buildTempPasswordEmailHtml({
          name: user.name,
          username: user.userLoginName,
          password: temporaryPassword,
          reason,
          loginUrl:
            reason === "user_created" ? env.APP_BASE_URL : undefined,
        }),
      });
    } catch {
      throw new AuthError("otp_delivery_failed");
    }
  }

  private async sendTemporaryPasswordEmail(
    user: AuthUser,
    temporaryPassword: string,
    reason: TempPasswordEmailReason,
  ): Promise<void> {
    await this.sendCredentialsEmail(user, temporaryPassword, reason);
  }

  private async sendOtpSms(
    mobile: string,
    otp: string,
    purpose: string,
  ): Promise<void> {
    const [template] = await db
      .select()
      .from(smsTemplates)
      .where(eq(smsTemplates.code, SMS_TEMPLATE_CODES.otp))
      .limit(1);

    if (!template) {
      throw new Error("OTP_SMS_TEMPLATE_MISSING");
    }

    const message = renderMessage(template.messageFormat, {
      OTP: otp,
      purpose,
    });
    const result = await sendSms(mobile, message, template.templateId);
    if (!result.ok) {
      throw new Error("OTP_SMS_GATEWAY_ERROR");
    }
  }

  private async clearLoginChallenge(userId: number): Promise<void> {
    await db
      .update(users)
      .set({
        loginChallengeId: null,
        loginOtpHash: null,
        loginOtpExpiresAt: null,
        loginOtpAttempts: 0,
        loginOtpChannel: null,
      })
      .where(eq(users.id, userId));
  }

  private async clearPasswordResetChallenge(userId: number): Promise<void> {
    await db
      .update(users)
      .set({
        passwordResetChallengeId: null,
        passwordResetOtpHash: null,
        passwordResetOtpExpiresAt: null,
        passwordResetOtpAttempts: 0,
        passwordResetOtpChannel: null,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      })
      .where(eq(users.id, userId));
  }

  private async setSession(
    userId: number,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    await db
      .update(users)
      .set({
        sessionId: token,
        sessionExpiresAt: formatUtcNow(expiresAt),
        lastLoginAt: formatUtcNow(),
        isLogin: true,
      })
      .where(eq(users.id, userId));
  }

  private generateSessionToken(): string {
    return randomBytes(32).toString("base64url");
  }
}

export const authService = new AuthService();

import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock, updateMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

const sendMailMock = vi.hoisted(() => vi.fn());
const sendSmsMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/email.js", () => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
}));

vi.mock("../lib/sms.js", () => ({
  sendSms: (...args: unknown[]) => sendSmsMock(...args),
}));

vi.mock("../env.js", () => ({
  env: {
    AUTH_2FA_ENABLED: true,
    NODE_ENV: "test",
  },
}));

const { AuthError, authService } = await import("./auth.service.js");

function md5(plain: string): string {
  return createHash("md5").update(plain, "utf8").digest("hex");
}

// Low cost keeps fixtures fast; verification reads the cost from the hash.
const bcryptSecret = bcrypt.hashSync("secret", 4);

const adminRole = {
  id: 1,
  code: "admin",
  name: "Admin",
  description: null,
  isAdmin: true,
  createdAt: "2024-01-01T00:00:00.000Z",
};

const bidderRole = {
  id: 2,
  code: "bidder",
  name: "Bidder",
  description: null,
  isAdmin: false,
  createdAt: "2024-01-01T00:00:00.000Z",
};

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    userLoginName: "staff.user",
    name: "Staff User",
    emailId: "staff@example.com",
    phoneNumber: "9876543210",
    password: bcryptSecret,
    passwordAlgo: "bcrypt",
    isActive: true,
    roleId: 1,
    bidderId: null,
    loginChallengeId: null,
    loginOtpHash: null,
    loginOtpExpiresAt: null,
    loginOtpAttempts: 0,
    loginOtpChannel: null,
    passwordResetChallengeId: null,
    passwordResetOtpHash: null,
    passwordResetOtpExpiresAt: null,
    passwordResetOtpAttempts: 0,
    passwordResetOtpChannel: null,
    passwordResetTokenHash: null,
    passwordResetTokenExpiresAt: null,
    passwordChanged: true,
    ...overrides,
  };
}

function mockSelectResult(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  selectMock.mockReturnValueOnce(chain);
  return chain;
}

function mockUpdateOk() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(async () => undefined);
  updateMock.mockReturnValueOnce(chain);
  return chain;
}

describe("AuthService.login", () => {
  beforeEach(() => {
    selectMock.mockReset();
    updateMock.mockReset();
    sendMailMock.mockReset();
    sendSmsMock.mockReset();
    sendMailMock.mockResolvedValue({ provider: "smtp", messageId: "1" });
    sendSmsMock.mockResolvedValue({
      ok: true,
      status: 200,
      response: "SUBMIT_SUCCESS",
    });
  });

  it("starts email OTP challenge for admin after password ok", async () => {
    const user = makeUser();
    mockSelectResult([{ user, role: adminRole }]);
    mockUpdateOk();

    const result = await authService.login("staff.user", "secret");
    expect(result.status).toBe("otp_required");
    if (result.status !== "otp_required") return;
    expect(result.challenge.channel).toBe("email");
    expect(result.challenge.destinationHint).toContain("@");
    expect(sendMailMock).toHaveBeenCalled();
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("starts SMS OTP challenge for bidder after password ok", async () => {
    const user = makeUser({
      userLoginName: "bidder@example.com",
      emailId: "bidder@example.com",
      roleId: 2,
      bidderId: 99,
    });
    mockSelectResult([{ user, role: bidderRole }]);
    mockUpdateOk();
    mockSelectResult([
      {
        id: 1,
        code: "otp",
        templateId: "1207161778554839403",
        purpose: "OTP",
        messageFormat:
          "{OTP} is your Authorization OTP for {purpose}. OTP will expire in 15 minutes. Regards- JindalX",
      },
    ]);

    const result = await authService.login("bidder@example.com", "secret");
    expect(result.status).toBe("otp_required");
    if (result.status !== "otp_required") return;
    expect(result.challenge.channel).toBe("sms");
    expect(sendSmsMock).toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("rejects wrong password", async () => {
    const user = makeUser();
    mockSelectResult([{ user, role: adminRole }]);

    await expect(
      authService.login("staff.user", "wrong"),
    ).rejects.toBeInstanceOf(AuthError);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    ["md5", md5("secret")],
    ["bcrypt_md5", bcrypt.hashSync(md5("secret"), 4)],
  ])("upgrades a %s row to bcrypt on login", async (algo, password) => {
    const user = makeUser({ password, passwordAlgo: algo });
    mockSelectResult([{ user, role: adminRole }]);
    const upgrade = mockUpdateOk();
    mockUpdateOk();

    const result = await authService.login("staff.user", "secret");
    expect(result.status).toBe("otp_required");
    const set = (upgrade.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      password: string;
      passwordAlgo: string;
    };
    expect(set.passwordAlgo).toBe("bcrypt");
    expect(await bcrypt.compare("secret", set.password)).toBe(true);
  });

  it("rejects wrong password on a bcrypt_md5 row without upgrading", async () => {
    const user = makeUser({
      password: bcrypt.hashSync(md5("secret"), 4),
      passwordAlgo: "bcrypt_md5",
    });
    mockSelectResult([{ user, role: adminRole }]);

    await expect(
      authService.login("staff.user", "wrong"),
    ).rejects.toBeInstanceOf(AuthError);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects unknown username", async () => {
    mockSelectResult([]);

    await expect(
      authService.login("nobody@example.com", "secret"),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("does not log in by email when userLoginName differs", async () => {
    mockSelectResult([]);

    await expect(
      authService.login("Staff@Example.com", "secret"),
    ).rejects.toBeInstanceOf(AuthError);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

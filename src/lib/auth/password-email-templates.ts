function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildAuthOtpEmailSubject(): string {
  return "Your AuctionIt verification OTP";
}

export function buildAuthOtpEmailHtml(otp: string): string {
  const safeOtp = escapeHtml(otp);
  return `<p>Your verification OTP is <strong>${safeOtp}</strong>.</p>
<p>It expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
<p>Regards,<br/>AuctionIt Team</p>`;
}

export type TempPasswordEmailReason =
  | "admin_reset"
  | "forgot_password"
  | "user_created";

export function buildTempPasswordEmailSubject(
  reason: TempPasswordEmailReason,
): string {
  if (reason === "user_created") {
    return "Your AuctionIt account credentials";
  }
  return "Your AuctionIt temporary password";
}

export function buildTempPasswordEmailHtml(vars: {
  name: string;
  username: string;
  password: string;
  reason: TempPasswordEmailReason;
  loginUrl?: string;
}): string {
  const name = escapeHtml(vars.name || "User");
  const username = escapeHtml(vars.username);
  const password = escapeHtml(vars.password);
  const intro =
    vars.reason === "user_created"
      ? "Welcome to AuctionIt! Here are your login details."
      : vars.reason === "admin_reset"
        ? "An administrator reset the password for your AuctionIt account."
        : "You completed password recovery for your AuctionIt account.";

  const loginLine = vars.loginUrl
    ? `<br/>\n  <strong>Link:</strong> ${escapeHtml(vars.loginUrl)}`
    : "";

  return `<p>Dear ${name},</p>
<p>${intro}</p>
<p>
  <strong>Username:</strong> ${username}<br/>
  <strong>Temporary password:</strong> ${password}${loginLine}
</p>
<p>Sign in and change this password before continuing.</p>
<p>If you didn't request this, contact support.</p>
<p>Regards,<br/>AuctionIt Team</p>`;
}

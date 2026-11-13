/**
 * Bidder portal — bank account update request emails (submitted / decision).
 */

export type BankAccountUpdateEmailVars = {
  companyName: string;
};

export type BankAccountUpdateDecision = "accepted" | "rejected";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildBankAccountUpdateSubmittedSubject(): string {
  return "Bank account update request received";
}

export function buildBankAccountUpdateSubmittedHtml(
  vars: BankAccountUpdateEmailVars,
): string {
  const companyName = escapeHtml(vars.companyName.trim() || "Sir/Madam");

  return `<html>
<body>
Dear ${companyName},
<br><br>
We received your bank account update request. An admin will verify it shortly.
<br><br>
Regards,<br>
AuctionIT Team.
</body>
</html>`;
}

export function buildBankAccountUpdateDecisionSubject(
  decision: BankAccountUpdateDecision,
): string {
  return decision === "accepted"
    ? "Bank account update verified"
    : "Bank account update rejected";
}

export function buildBankAccountUpdateDecisionHtml(
  vars: BankAccountUpdateEmailVars & {
    decision: BankAccountUpdateDecision;
  },
): string {
  const companyName = escapeHtml(vars.companyName.trim() || "Sir/Madam");

  const message =
    vars.decision === "accepted"
      ? "Your bank account update has been verified and is now active."
      : "Your bank account update request was rejected. Please submit again with correct details if needed.";

  return `<html>
<body>
Dear ${companyName},
<br><br>
${message}
<br><br>
Regards,<br>
AuctionIT Team.
</body>
</html>`;
}

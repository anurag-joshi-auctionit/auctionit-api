/**
 * Legacy Non-JSL lot confirmation email (NotificationType 4).
 */

// export const LOT_CONFIRMATION_EMAIL_CC: string | null =
//   "lotconfirmation@auctionit.in";
export const LOT_CONFIRMATION_EMAIL_CC: string | null = null;
export const LOT_CONFIRMATION_EMAIL_BCC: string | null = null;

export type LotConfirmationEmailVars = {
  bidderCompany: string;
  clientName: string;
  auctionNumber: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildLotConfirmationEmailSubject(
  vars: Pick<LotConfirmationEmailVars, "bidderCompany" | "auctionNumber">,
): string {
  return `Lot Confirmation Letter - ${vars.bidderCompany} For ${vars.auctionNumber}`;
}

export function buildLotConfirmationEmailHtml(
  vars: LotConfirmationEmailVars,
): string {
  const bidderCompany = escapeHtml(vars.bidderCompany.trim() || "Sir/Madam");
  const clientName = escapeHtml(vars.clientName);

  return `<html>
<body>
Dear ${bidderCompany},
<br><br>
This is with reference to your offer given to us for the attached lot with respect to above subject.
<br><br>
Your bid has been accepted by ${clientName} for the lot as mentioned in the Letter, and we congratulate you for the same.
<br><br>
Please find enclosed Lot Confirmation Letter.
<br><br>
Material is sold on “as is where basis is”.
<br><br>
Sincerely,<br>
iCom Analytics Limited
<br><br>
Visit us on the web at: www.auctionit.in
</body>
</html>`;
}

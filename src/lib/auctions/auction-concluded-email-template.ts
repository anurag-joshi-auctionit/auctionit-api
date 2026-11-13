/**
 * Legacy NotificationId 5 — Auction has been concluded.
 */

export type AuctionConcludedEmailVars = {
  companyName: string;
  auctionNumber: string;
  /** App-wide date display, e.g. `30 Jun 2026`. */
  auctionDate: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildAuctionConcludedSubject(
  vars: Pick<AuctionConcludedEmailVars, "auctionNumber" | "auctionDate">,
): string {
  return `Auction Concluded (${vars.auctionNumber} on ${vars.auctionDate})`;
}

export function buildAuctionConcludedHtml(
  vars: AuctionConcludedEmailVars,
): string {
  const companyName = escapeHtml(vars.companyName);
  const auctionNumber = escapeHtml(vars.auctionNumber);
  const auctionDate = escapeHtml(vars.auctionDate);

  return `<html>
<body>
Dear ${companyName},
<br><br>
${auctionNumber} Dated ${auctionDate} has been concluded.
<br><br>
Thanks for participation.
<br><br>
Regards,<br>
AuctionIT Team.
</body>
</html>`;
}

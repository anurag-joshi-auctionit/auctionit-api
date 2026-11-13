/**
 * Legacy NotificationId 3 — Auction about to start.
 */

export type AuctionAboutToStartEmailVars = {
  companyName: string;
  auctionNumber: string;
  /** App-wide time display, e.g. `3:00 PM`. */
  startTime: string;
  /** App-wide date display, e.g. `30 Jun 2026`. */
  auctionDate: string;
  loginUrl: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildAuctionAboutToStartSubject(
  vars: Pick<AuctionAboutToStartEmailVars, "auctionNumber" | "auctionDate">,
): string {
  return `Auction is about to start (${vars.auctionNumber} on ${vars.auctionDate})`;
}

export function buildAuctionAboutToStartHtml(
  vars: AuctionAboutToStartEmailVars,
): string {
  const companyName = escapeHtml(vars.companyName);
  const auctionNumber = escapeHtml(vars.auctionNumber);
  const startTime = escapeHtml(vars.startTime);
  const auctionDate = escapeHtml(vars.auctionDate);
  const loginUrl = escapeHtml(vars.loginUrl);

  return `<html>
<body>
Dear ${companyName},
<br><br>
Auction ${auctionNumber} will start at ${startTime} Dated ${auctionDate}.
<br>
Request you to please login in ${loginUrl}
<br><br>
Regards,<br>
AuctionIT Team.
</body>
</html>`;
}

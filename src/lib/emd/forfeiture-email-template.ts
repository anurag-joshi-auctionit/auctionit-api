/** Bidder notice sent when the HOD approves a forfeiture of winning EMD. */

export type EmdForfeitureEmailVars = {
  companyName: string;
  auctionNumber: string;
  lots: string | null;
  /** App-wide currency display, e.g. `₹50,000.00`. */
  amount: string;
  reason: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildEmdForfeitureEmailSubject(auctionNumber: string): string {
  return `EMD forfeited for auction ${auctionNumber}`;
}

export function buildEmdForfeitureEmailHtml(vars: EmdForfeitureEmailVars): string {
  const lots = vars.lots ? ` (${escapeHtml(vars.lots)})` : "";
  return `<html>
<body>
Dear ${escapeHtml(vars.companyName)},
<br><br>
Your EMD of ${escapeHtml(vars.amount)} held against the lots you won in auction
${escapeHtml(vars.auctionNumber)}${lots} has been forfeited.
<br><br>
Reason: ${escapeHtml(vars.reason)}
<br><br>
This amount is no longer part of your EMD balance. For any questions, please contact the AuctionIt team.
<br><br>
Regards,
<br>
Team AuctionIt
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildRaStageInviteSubject(stageLabel: string): string {
  return `Invitation to participate in ${stageLabel}`;
}

export function buildRaStageInviteHtml(companyName: string, stageLabel: string): string {
  return `
    <p>Dear ${escapeHtml(companyName)},</p>
    <p>You have been invited to participate in the <strong>${escapeHtml(stageLabel)}</strong> stage of a sourcing process on AuctionIT.</p>
    <p>Please log in to the bidder portal to view the questions and submit your response.</p>
  `.trim();
}

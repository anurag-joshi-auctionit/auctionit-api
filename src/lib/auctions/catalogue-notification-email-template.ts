/**
 * Catalogue notification email — port of legacy CatalogueNotification MessageBoday().
 */

import type { CatalogueNotificationType } from "../../db/schema/auction-catalogue-notifications.js";

export type CatalogueNotificationEmailVars = {
  catalogueType: CatalogueNotificationType;
  clientName: string;
  plantLocationsSummary: string;
  materialsSummary: string;
  auctionNumber: string;
  /** App-wide date display, e.g. `30 Jun 2026`. */
  auctionDate: string;
  /** Bidder portal link to view/download the catalogue. */
  catalogueUrl: string;
  additionalInfo?: string | null;
  reasonForRevision?: string | null;
  kamContact?: string | null;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plantPrefix(
  clientName: string,
  plantLocationsSummary: string,
): string {
  const plants = plantLocationsSummary.trim();
  if (plants.length > 0) return `${clientName} - ${plants}`;
  return clientName;
}

export function buildCatalogueNotificationSubject(
  vars: Pick<
    CatalogueNotificationEmailVars,
    | "catalogueType"
    | "clientName"
    | "plantLocationsSummary"
    | "materialsSummary"
    | "auctionNumber"
    | "auctionDate"
  >,
): string {
  const catalogueWord =
    vars.catalogueType === "revised" ? "Revised Catalogue" : "Catalogue";
  const prefix = plantPrefix(vars.clientName, vars.plantLocationsSummary);
  return `${prefix} Auction ${catalogueWord} "${vars.materialsSummary}" in an online auction ${vars.auctionNumber} on ${vars.auctionDate}`.slice(
    0,
    250,
  );
}

export function buildCatalogueNotificationHtml(
  vars: CatalogueNotificationEmailVars,
): string {
  const clientName = escapeHtml(vars.clientName);
  const plants = escapeHtml(vars.plantLocationsSummary.trim());
  const materialsSummary = escapeHtml(vars.materialsSummary);
  const auctionNumber = escapeHtml(vars.auctionNumber);
  const auctionDate = escapeHtml(vars.auctionDate);
  const catalogueUrl = escapeHtml(vars.catalogueUrl);

  const locationBit =
    plants.length > 0 ? `${clientName} - ${plants}` : clientName;
  const opening = `${locationBit} "${materialsSummary}" in an online auction ${auctionNumber} on ${auctionDate}.`;

  let additionalInfo = "";
  const info = vars.additionalInfo?.trim() ?? "";
  if (info.length > 0) {
    additionalInfo = `<br><br><b>${escapeHtml(info)}</b>`;
  }

  let revised = "<br>";
  const reason = vars.reasonForRevision?.trim() ?? "";
  if (reason.length > 0) {
    revised = `<br><br>Below are the reasons for revised catalogue:<br>${escapeHtml(reason)}<br>`;
  } else if (info.length > 0) {
    additionalInfo = `${additionalInfo}<br>`;
  }

  const kam = vars.kamContact?.trim() ?? "";
  const kamBit = kam.length > 0 ? `<b>${escapeHtml(kam)}</b> and ` : "";

  return `<html>
<body>
Dear Sir,
<br><br>
${opening}${additionalInfo}${revised}
<br>
Please <b><a href="${catalogueUrl}" target="_blank">click here</a></b> to download the Catalogue; you are requested to inspect the material/lot before bidding.
<br><br>
Looking forward for your participation on <b>${auctionDate}.</b>
<br><br>
We request you to kindly fill the LOI, and send it to: <b>loi@auctionit.in</b>
<br><br>
Best regards,<br>
AuctionIt Team<br>
iCom Analytics Limited,<br>
28 Najafgarh Road, New Delhi 110015<br>
http://www.auctionit.in
<br><br>
<h2>Note: Please check the GST taxation in the catalogue.</h2><br>
In case you have any questions, please feel free to get in touch with ${kamBit}<b>Ajeet Kumar Singh (9935889777).</b>
</body>
</html>`;
}

import { describe, expect, it } from "vitest";
import {
  buildLotConfirmationEmailHtml,
  buildLotConfirmationEmailSubject,
  LOT_CONFIRMATION_EMAIL_CC,
} from "./lot-confirmation-email-template.js";

describe("lot confirmation email", () => {
  it("builds the subject from bidder company and auction number", () => {
    expect(
      buildLotConfirmationEmailSubject({
        bidderCompany: "Janta Scrap Collector",
        auctionNumber: "AUC-100",
      }),
    ).toBe("Lot Confirmation Letter - Janta Scrap Collector For AUC-100");
  });

  // CC to lotconfirmation@auctionit.in is intentionally disabled for now.
  it("sends no CC", () => {
    expect(LOT_CONFIRMATION_EMAIL_CC).toBeNull();
  });

  it("escapes HTML in the body", () => {
    const html = buildLotConfirmationEmailHtml({
      bidderCompany: "Acme <Ltd>",
      clientName: "Manaksia & Co",
      auctionNumber: "AUC-1",
    });
    expect(html).toContain("Dear Acme &lt;Ltd&gt;,");
    expect(html).toContain("accepted by Manaksia &amp; Co");
    expect(html).toContain("Please find enclosed Lot Confirmation Letter.");
  });
});

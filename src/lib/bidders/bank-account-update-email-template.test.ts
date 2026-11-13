import { describe, expect, it } from "vitest";
import {
  buildBankAccountUpdateDecisionHtml,
  buildBankAccountUpdateDecisionSubject,
  buildBankAccountUpdateSubmittedHtml,
  buildBankAccountUpdateSubmittedSubject,
} from "./bank-account-update-email-template.js";

describe("bank account update submitted email", () => {
  it("builds a fixed subject", () => {
    expect(buildBankAccountUpdateSubmittedSubject()).toBe(
      "Bank account update request received",
    );
  });

  it("builds body with company greeting", () => {
    const html = buildBankAccountUpdateSubmittedHtml({
      companyName: "Acme Scrap Pvt Ltd",
    });
    expect(html).toContain("Dear Acme Scrap Pvt Ltd,");
    expect(html).toContain(
      "We received your bank account update request. An admin will verify it shortly.",
    );
    expect(html).toContain("AuctionIT Team.");
  });

  it("escapes HTML in the company name", () => {
    const html = buildBankAccountUpdateSubmittedHtml({
      companyName: "Acme <Ltd> & Co",
    });
    expect(html).toContain("Dear Acme &lt;Ltd&gt; &amp; Co,");
    expect(html).not.toContain("Acme <Ltd>");
  });
});

describe("bank account update decision email", () => {
  it("builds accepted and rejected subjects", () => {
    expect(buildBankAccountUpdateDecisionSubject("accepted")).toBe(
      "Bank account update verified",
    );
    expect(buildBankAccountUpdateDecisionSubject("rejected")).toBe(
      "Bank account update rejected",
    );
  });

  it("builds accepted body", () => {
    const html = buildBankAccountUpdateDecisionHtml({
      companyName: "Acme Scrap Pvt Ltd",
      decision: "accepted",
    });
    expect(html).toContain("Dear Acme Scrap Pvt Ltd,");
    expect(html).toContain(
      "Your bank account update has been verified and is now active.",
    );
  });

  it("builds rejected body", () => {
    const html = buildBankAccountUpdateDecisionHtml({
      companyName: "Acme Scrap Pvt Ltd",
      decision: "rejected",
    });
    expect(html).toContain(
      "Your bank account update request was rejected. Please submit again with correct details if needed.",
    );
  });
});

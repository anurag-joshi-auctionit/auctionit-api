import { describe, expect, it } from "vitest";
import {
  buildCatalogueNotificationHtml,
  buildCatalogueNotificationSubject,
} from "./catalogue-notification-email-template.js";

describe("catalogue notification email template", () => {
  const base = {
    catalogueType: "new" as const,
    clientName: "Surya Roshni Limited",
    plantLocationsSummary: "Bhuj, Malanpur",
    materialsSummary: "Rejected Pipe, H.R COIL AND OTHER SCRAP",
    auctionNumber: "SRL/e-Sales/2018-19/FA-44",
    auctionDate: "01 Oct 2018",
    catalogueUrl: "https://example.r2.cloudflarestorage.com/catalogue.pdf?X-Amz-Signature=test",
  };

  it("builds subject for new catalogue", () => {
    const subject = buildCatalogueNotificationSubject(base);
    expect(subject).toBe(
      'Surya Roshni Limited - Bhuj, Malanpur Auction Catalogue "Rejected Pipe, H.R COIL AND OTHER SCRAP" in an online auction SRL/e-Sales/2018-19/FA-44 on 01 Oct 2018',
    );
  });

  it("builds subject for revised catalogue", () => {
    const subject = buildCatalogueNotificationSubject({
      ...base,
      catalogueType: "revised",
    });
    expect(subject).toContain("Auction Revised Catalogue");
  });

  it("truncates subject to 250 chars", () => {
    const subject = buildCatalogueNotificationSubject({
      ...base,
      materialsSummary: "X".repeat(400),
    });
    expect(subject.length).toBe(250);
  });

  it("includes additional info, revision reason, and kam in body", () => {
    const html = buildCatalogueNotificationHtml({
      ...base,
      catalogueType: "revised",
      additionalInfo: "Extra note",
      reasonForRevision: "Price correction",
      kamContact: "Ravi (9999999999)",
    });
    expect(html).toContain("<b>Extra note</b>");
    expect(html).toContain("Below are the reasons for revised catalogue:");
    expect(html).toContain("Price correction");
    expect(html).toContain("<b>Ravi (9999999999)</b> and ");
    // "click here" downloads the catalogue PDF via its signed URL.
    expect(html).toContain(`href="${base.catalogueUrl}"`);
    expect(html).toContain("Bhuj, Malanpur");
  });

  it("escapes html in user-provided fields", () => {
    const html = buildCatalogueNotificationHtml({
      ...base,
      materialsSummary: '<script>alert("x")</script>',
      additionalInfo: "A & B < C",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B &lt; C");
  });
});

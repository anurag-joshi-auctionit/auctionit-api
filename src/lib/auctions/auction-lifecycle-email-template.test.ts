import { describe, expect, it } from "vitest";
import { formatDate, formatTimeOfDay } from "@auctionit/lib/date";
import {
  buildAuctionAboutToStartHtml,
  buildAuctionAboutToStartSubject,
} from "./auction-about-to-start-email-template.js";
import {
  buildAuctionConcludedHtml,
  buildAuctionConcludedSubject,
} from "./auction-concluded-email-template.js";

const auctionDate = formatDate("2026-06-30");
const startTime = formatTimeOfDay("15:00:00");

describe("auction about-to-start email", () => {
  it("builds subject from auction number and app-UI date", () => {
    expect(
      buildAuctionAboutToStartSubject({
        auctionNumber: "iComFA-Test1",
        auctionDate,
      }),
    ).toBe("Auction is about to start (iComFA-Test1 on 30 Jun 2026)");
  });

  it("builds body with greeting, start time, date, and login url", () => {
    const html = buildAuctionAboutToStartHtml({
      companyName: "Viraj Profiles Private Limited",
      auctionNumber: "iComFA-Test1",
      startTime,
      auctionDate,
      loginUrl: "http://localhost:3002",
    });
    expect(html).toContain("Dear Viraj Profiles Private Limited,");
    expect(html).toContain(
      "Auction iComFA-Test1 will start at 3:00 PM Dated 30 Jun 2026.",
    );
    expect(html).toContain(
      "Request you to please login in http://localhost:3002",
    );
    expect(html).toContain("AuctionIT Team.");
    expect(html).not.toContain("<!DOCTYPE");
  });

  it("escapes HTML in the body", () => {
    const html = buildAuctionAboutToStartHtml({
      companyName: "Acme <Ltd>",
      auctionNumber: "AUC & Co",
      startTime,
      auctionDate,
      loginUrl: "http://example.com/?a=1&b=2",
    });
    expect(html).toContain("Dear Acme &lt;Ltd&gt;,");
    expect(html).toContain("Auction AUC &amp; Co will start at");
    expect(html).toContain("http://example.com/?a=1&amp;b=2");
  });
});

describe("auction concluded email", () => {
  it("builds subject from auction number and app-UI date", () => {
    expect(
      buildAuctionConcludedSubject({
        auctionNumber: "JSAW NSK/e-Sales/2024-25/FA-20",
        auctionDate: formatDate("2024-06-08"),
      }),
    ).toBe(
      "Auction Concluded (JSAW NSK/e-Sales/2024-25/FA-20 on 08 Jun 2024)",
    );
  });

  it("builds body with greeting and participation thanks", () => {
    const html = buildAuctionConcludedHtml({
      companyName: "Viraj Profiles Private Limited",
      auctionNumber: "JSAW NSK/e-Sales/2024-25/FA-20",
      auctionDate: formatDate("2024-06-08"),
    });
    expect(html).toContain("Dear Viraj Profiles Private Limited,");
    expect(html).toContain(
      "JSAW NSK/e-Sales/2024-25/FA-20 Dated 08 Jun 2024 has been concluded.",
    );
    expect(html).toContain("Thanks for participation.");
    expect(html).toContain("AuctionIT Team.");
  });

  it("escapes HTML in the body", () => {
    const html = buildAuctionConcludedHtml({
      companyName: "Acme <Ltd>",
      auctionNumber: "AUC & Co",
      auctionDate,
    });
    expect(html).toContain("Dear Acme &lt;Ltd&gt;,");
    expect(html).toContain("AUC &amp; Co Dated 30 Jun 2026 has been concluded.");
  });
});

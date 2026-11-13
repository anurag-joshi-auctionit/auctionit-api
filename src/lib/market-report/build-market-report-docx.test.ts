import { describe, expect, it } from "vitest";
import type { MarketReport } from "../../services/market-report.service.js";
import {
  buildMarketReportDocx,
  buildMarketReportFilename,
  formatReportAmount,
  formatReportDate,
  formatReportTime,
} from "./build-market-report-docx.js";
import { isRichTextWithinLimits, richTextNodeSchema } from "./rich-text.js";

const report: MarketReport = {
  header: {
    auctionId: 9881,
    auctionNumber: "SRL/e-Sales/2026-27/FA-05",
    auctionDate: "2026-04-17",
    clientName: "Surya Roshni Limited",
    startTime: "14:00",
    endTime: "18:00",
  },
  series: [
    {
      comboId: 1,
      material: "CRCA",
      location: "Delhi",
      currency: "INR",
      label: "CRCA (Delhi)",
    },
  ],
  rows: [
    { date: "2026-04-15", prices: { "1": 65000 } },
    { date: "2026-04-16", prices: { "1": 65500 } },
  ],
  lots: [
    {
      lotNumber: "Lot 1",
      description: "CQ COIL",
      quantity: 10.507,
      previousAuctionDate: "2026-04-08",
      previousBenchmarkPrice: 65000,
      currentBenchmarkPrice: 65500,
      previousSbp: 56500,
      previousWinningPrice: null,
      suggestedSbp: 58500,
    },
  ],
};

describe("market report formatting", () => {
  it("formats amounts in en-IN and shows NA for null or zero", () => {
    expect(formatReportAmount(158500)).toBe("1,58,500");
    expect(formatReportAmount(10.507, 3)).toBe("10.507");
    expect(formatReportAmount(null)).toBe("NA");
    expect(formatReportAmount(0)).toBe("NA");
  });

  it("formats dates and 12h times", () => {
    expect(formatReportDate("2026-04-08")).toBe("08 Apr 2026");
    expect(formatReportTime("14:00")).toBe("02:00 PM");
    expect(formatReportTime("00:30")).toBe("12:30 AM");
    expect(formatReportTime(null)).toBeNull();
  });

  it("builds a filename safe for Content-Disposition", () => {
    expect(buildMarketReportFilename(report)).toBe(
      "Market Report of Surya Roshni Limited SRL-e-Sales-2026-27-FA-05 Dated - 17.04.2026.docx",
    );
  });
});

describe("market making rich text", () => {
  it("accepts the editor whitelist and rejects other nodes", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "51 buyers", marks: [{ type: "bold" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = richTextNodeSchema.parse(doc);
    expect(isRichTextWithinLimits(parsed)).toBe(true);
    expect(
      richTextNodeSchema.safeParse({ type: "doc", content: [{ type: "image" }] })
        .success,
    ).toBe(false);
    expect(
      richTextNodeSchema.safeParse({
        type: "doc",
        content: [{ type: "text", text: "x", marks: [{ type: "link" }] }],
      }).success,
    ).toBe(false);
  });

  it("produces a docx zip with the chart image", async () => {
    const buffer = await buildMarketReportDocx(report, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    expect(buffer.includes(Buffer.from("word/media/"))).toBe(true);
  });
});

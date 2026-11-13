import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { WINNER_LABEL } from "@auctionit/lib/winner-rank";
import {
  SI_ANNEXURE_BIDDER_HEADER,
  SI_ANNEXURE_PRICE_HEADER,
  siAnnexureTemplateHeaders,
} from "./annexure-constants.js";
import { parseServiceInvoiceAnnexureBuffer } from "./annexure-parse.js";
import { aggregateAnnexureTotals } from "./annexure-totals.js";

async function buildXlsx(
  rows: Array<Array<string | number | Date | null>>,
  headers = siAnnexureTemplateHeaders().map((h) => h.key),
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Annexure");
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(row);
  }
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

const LEGACY_H1_HEADERS = [
  "Auction No.",
  "Auction Date",
  "Lot No.",
  "Product",
  "Approved Qty.",
  "Unit",
  "H1 Price",
  "H1 Bidder",
  "Lifted Qty.",
  "Amount",
];

const LEGACY_L1_HEADERS = [
  "Auction No.",
  "Auction Date",
  "Lot No.",
  "Product",
  "Approved Qty.",
  "Unit",
  "L1 Price",
  "L1 Bidder",
  "Lifted Qty.",
  "Amount",
];

describe("aggregateAnnexureTotals", () => {
  it("sums lifted qty and amount across lines", () => {
    expect(
      aggregateAnnexureTotals([
        {
          lineOrder: 1,
          auctionNumber: "A1",
          auctionDate: "2026-01-01",
          lotNumber: "1",
          product: "Scrap",
          approvedQty: 10,
          uom: "MT",
          rankLabel: WINNER_LABEL,
          winningPrice: 100,
          bidderName: "Bidder",
          liftedQty: 2.5,
          amount: 250,
        },
        {
          lineOrder: 2,
          auctionNumber: "A2",
          auctionDate: "2026-01-02",
          lotNumber: "2",
          product: "Scrap",
          approvedQty: 5,
          uom: "MT",
          rankLabel: WINNER_LABEL,
          winningPrice: 80,
          bidderName: "Bidder",
          liftedQty: 1.5,
          amount: 120,
        },
      ]),
    ).toEqual({ totalQuantity: 4, totalAmount: 370 });
  });
});

describe("parseServiceInvoiceAnnexureBuffer", () => {
  it("accepts a fully valid Winning workbook", async () => {
    const buffer = await buildXlsx([
      [
        "AUC-1",
        "2026-01-15",
        "L-1",
        "MS Scrap",
        10,
        "MT",
        100,
        "Acme",
        2,
        200,
      ],
    ]);

    const result = await parseServiceInvoiceAnnexureBuffer(buffer);
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines?.[0]).toMatchObject({
      auctionNumber: "AUC-1",
      lotNumber: "L-1",
      liftedQty: 2,
      amount: 200,
      bidderName: "Acme",
      winningPrice: 100,
      rankLabel: WINNER_LABEL,
    });
    expect(result.totals).toEqual({ totalQuantity: 2, totalAmount: 200 });
  });

  it("accepts a legacy H1 workbook", async () => {
    const buffer = await buildXlsx(
      [
        [
          "AUC-1",
          "2026-01-15",
          "L-1",
          "MS Scrap",
          10,
          "MT",
          100,
          "Acme",
          2,
          200,
        ],
      ],
      LEGACY_H1_HEADERS,
    );

    const result = await parseServiceInvoiceAnnexureBuffer(buffer);
    expect(result.imported).toBe(1);
    expect(result.lines?.[0]).toMatchObject({
      winningPrice: 100,
      rankLabel: WINNER_LABEL,
    });
  });

  it("accepts a legacy L1 (reverse) workbook", async () => {
    const buffer = await buildXlsx(
      [
        [
          "AUC-R1",
          "2026-01-15",
          "L-1",
          "MS Scrap",
          10,
          "MT",
          50,
          "Acme",
          2,
          100,
        ],
      ],
      LEGACY_L1_HEADERS,
    );

    const result = await parseServiceInvoiceAnnexureBuffer(buffer);
    expect(result.imported).toBe(1);
    expect(result.lines?.[0]).toMatchObject({
      winningPrice: 50,
      amount: 100,
      rankLabel: WINNER_LABEL,
    });
  });

  it("rejects the entire file when any row fails", async () => {
    const buffer = await buildXlsx([
      [
        "AUC-1",
        "2026-01-15",
        "L-1",
        "MS Scrap",
        10,
        "MT",
        100,
        "Acme",
        2,
        200,
      ],
      [
        "AUC-2",
        "2026-01-16",
        "L-2",
        "MS Scrap",
        10,
        "MT",
        100,
        "Acme",
        2,
        999,
      ],
    ]);

    const result = await parseServiceInvoiceAnnexureBuffer(buffer);
    expect(result.imported).toBe(0);
    expect(result.lines).toBeUndefined();
    expect(result.failed).toBeGreaterThan(0);
    expect(
      result.issues.some((i) => i.message.includes(SI_ANNEXURE_PRICE_HEADER)),
    ).toBe(true);
  });

  it("rejects mixing Winning and legacy H1 headers", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Annexure");
    sheet.addRow([
      "Auction No.",
      "Auction Date",
      "Lot No.",
      "Product",
      "Approved Qty.",
      "Unit",
      SI_ANNEXURE_PRICE_HEADER,
      "H1 Bidder",
      "Lifted Qty.",
      "Amount",
    ]);
    sheet.addRow(["A1", "2026-01-15", "1", "P", 1, "MT", 10, "B", 1, 10]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await parseServiceInvoiceAnnexureBuffer(buf);
    expect(result.imported).toBe(0);
    expect(result.issues[0]?.message).toMatch(/not mixed rank pairs/);
  });

  it("rejects mixing H1 and L1 price/bidder headers", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Annexure");
    sheet.addRow([
      "Auction No.",
      "Auction Date",
      "Lot No.",
      "Product",
      "Approved Qty.",
      "Unit",
      "H1 Price",
      "L1 Bidder",
      "Lifted Qty.",
      "Amount",
    ]);
    sheet.addRow(["A1", "2026-01-15", "1", "P", 1, "MT", 10, "B", 1, 10]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await parseServiceInvoiceAnnexureBuffer(buf);
    expect(result.imported).toBe(0);
    expect(result.issues[0]?.message).toMatch(/not mixed rank pairs/);
  });

  it("rejects missing required headers", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Annexure");
    sheet.addRow(["Auction No.", "Lot No."]);
    sheet.addRow(["A1", "1"]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await parseServiceInvoiceAnnexureBuffer(buf);
    expect(result.imported).toBe(0);
    expect(result.issues[0]?.message).toMatch(/Missing required column/);
  });

  it("accepts legacy AuctionIT5.0 auction annexure headers", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Annexure");
    sheet.addRow([
      "Auction Number",
      "Auction Date",
      "Lot No.",
      "Category",
      "Product",
      "Approved Qty.",
      "Unit",
      "Highest Price",
      "Party (H1)",
      "Lifted Qty",
      "Amount",
    ]);
    sheet.addRow([
      "JSAW/e-Sales/2023-24/FA-195",
      "12/Jan/2024",
      "Lot 7",
      "NFER&M",
      "Used Conveyor Belt",
      30,
      "MT",
      32500,
      "Shri panchmukhi trading",
      28.21,
      916825,
    ]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await parseServiceInvoiceAnnexureBuffer(buf);
    expect(result.imported).toBe(1);
    expect(result.lines?.[0]).toMatchObject({
      auctionNumber: "JSAW/e-Sales/2023-24/FA-195",
      auctionDate: "2024-01-12",
      winningPrice: 32500,
      bidderName: "Shri panchmukhi trading",
      liftedQty: 28.21,
      amount: 916825,
      rankLabel: WINNER_LABEL,
    });
  });

  it("accepts truncated legacy Auction Number header", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow([
      "uction Number",
      "Auction Date",
      "Lot No.",
      "Category",
      "Product",
      "Approved Qty.",
      "Unit",
      "Highest Price",
      "Party (H1)",
      "Lifted Qty",
      "Amount",
    ]);
    sheet.addRow([
      "AUC-1",
      "2024-01-12",
      "Lot 1",
      "FER",
      "Scrap",
      2.3,
      "MT",
      125000,
      "Mega Steels",
      2.29,
      286250,
    ]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await parseServiceInvoiceAnnexureBuffer(buf);
    expect(result.imported).toBe(1);
    expect(result.lines?.[0]?.auctionNumber).toBe("AUC-1");
  });

  it("accepts legacy tax-invoice style annexures", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Annexure");
    sheet.addRow([
      "Sr No.",
      "Tax Invoice No.",
      "Date",
      "Sold to Party Name",
      "Material Description",
      "NOS",
      "Lifted Qty",
      "Net Weight (Kgs)",
      "Rate",
      "Amount",
    ]);
    sheet.addRow([
      1,
      "GJ232401002863",
      "2023-05-01",
      "CRYSTAL TUBES",
      "IS-3589 pipe",
      41,
      485.72,
      25190,
      55200,
      1390488,
    ]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await parseServiceInvoiceAnnexureBuffer(buf);
    expect(result.imported).toBe(1);
    expect(result.lines?.[0]).toMatchObject({
      auctionNumber: "GJ232401002863",
      product: "IS-3589 pipe",
      bidderName: "CRYSTAL TUBES",
      winningPrice: 55200,
      liftedQty: 485.72,
      amount: 1390488,
    });
    expect(result.totals).toEqual({
      totalQuantity: 485.72,
      totalAmount: 1390488,
    });
  });

  it("template headers use Winning Price and Winning Bidder", () => {
    const keys = siAnnexureTemplateHeaders().map((h) => h.key);
    expect(keys).toContain(SI_ANNEXURE_PRICE_HEADER);
    expect(keys).toContain(SI_ANNEXURE_BIDDER_HEADER);
    expect(keys).not.toContain("H1 Price");
  });
});

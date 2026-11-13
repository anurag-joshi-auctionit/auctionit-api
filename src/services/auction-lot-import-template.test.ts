import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import {
  AUCTION_LOT_IMPORT_SHEET,
  AUCTION_LOT_IMPORT_TEMPLATE_HEADERS,
} from "../lib/auction-lot-import-constants.js";

vi.mock("./auctions-pg.service.js", () => ({
  pgListLotEditorOptions: vi.fn(async () => ({
    plantLocations: [],
    materialLocations: [],
    uoms: [],
    items: [],
    benchmarks: [],
  })),
}));

const { buildAuctionLotImportTemplateXlsx } = await import(
  "./auction-lot-import-template.js"
);

describe("buildAuctionLotImportTemplateXlsx", () => {
  it("formats lot start and end time columns as text to avoid Excel AM/PM", async () => {
    const buffer = await buildAuctionLotImportTemplateXlsx(1);
    const workbook = new ExcelJS.Workbook();
    // exceljs typings accept Buffer via ArrayBuffer-like input
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheet = workbook.getWorksheet(AUCTION_LOT_IMPORT_SHEET);
    expect(sheet).toBeDefined();

    const startCol =
      AUCTION_LOT_IMPORT_TEMPLATE_HEADERS.findIndex(
        (h) => h.key === "lotStartTime",
      ) + 1;
    const endCol =
      AUCTION_LOT_IMPORT_TEMPLATE_HEADERS.findIndex(
        (h) => h.key === "lotEndTime",
      ) + 1;

    expect(sheet!.getColumn(startCol).numFmt).toBe("@");
    expect(sheet!.getColumn(endCol).numFmt).toBe("@");
    expect(sheet!.getRow(2).getCell(startCol).numFmt).toBe("@");
    expect(sheet!.getRow(2).getCell(endCol).numFmt).toBe("@");
  });
});

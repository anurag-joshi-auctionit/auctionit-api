import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildRowsXlsx } from "./build-rows-xlsx.js";
import {
  columnRangeFrom,
  ignoreNumberStoredAsText,
} from "./ignore-number-as-text.js";
import { injectSheetLogo } from "./inject-sheet-logo.js";

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

type Row = { lot: string; phone: string; qty: number };

async function sheetXml(xlsx: Buffer, path = "xl/worksheets/sheet1.xml") {
  const zip = await JSZip.loadAsync(xlsx);
  return zip.file(path)!.async("string");
}

describe("columnRangeFrom", () => {
  it("covers the column from the start row to the last Excel row", () => {
    expect(columnRangeFrom(1, 4)).toBe("A4:A1048576");
    expect(columnRangeFrom(28, 2)).toBe("AB2:AB1048576");
  });
});

describe("buildRowsXlsx asText columns", () => {
  it("keeps values as strings and ignores number-stored-as-text on those columns", async () => {
    const buffer = await buildRowsXlsx<Row>({
      sheetName: "Report",
      title: "Report",
      generatedAt: "01 Oct 2026, 1:00:00 pm",
      columns: [
        { header: "Lot No.", asText: true, value: (r) => r.lot },
        { header: "Qty", value: (r) => r.qty },
        { header: "Phone", asText: true, value: (r) => r.phone },
      ],
      rows: [{ lot: "001", phone: "9876543210", qty: 5 }],
    });

    const xml = await sheetXml(buffer);
    expect(xml).toContain(
      '<ignoredErrors><ignoredError sqref="A4:A1048576 C4:C1048576" numberStoredAsText="1"/></ignoredErrors>',
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Report")!;
    expect(sheet.getRow(4).getCell(1).value).toBe("001");
    expect(sheet.getRow(4).getCell(3).value).toBe("9876543210");
  });

  it("leaves the sheet untouched when no column is asText", async () => {
    const buffer = await buildRowsXlsx<Row>({
      sheetName: "Report",
      columns: [{ header: "Qty", value: (r) => r.qty }],
      rows: [{ lot: "1", phone: "1", qty: 5 }],
    });
    expect(await sheetXml(buffer)).not.toContain("<ignoredErrors>");
  });
});

describe("ignoreNumberStoredAsText", () => {
  it("places ignoredErrors before the drawing element added for the logo", async () => {
    const base = await buildRowsXlsx<Row>({
      sheetName: "Report",
      columns: [{ header: "Lot No.", asText: true, value: (r) => r.lot }],
      rows: [{ lot: "12", phone: "", qty: 0 }],
    });
    const withLogo = await injectSheetLogo(base, {
      image: TINY_JPEG,
      sheetNames: ["Report"],
      widthPx: 10,
      heightPx: 10,
    });

    const xml = await sheetXml(withLogo);
    expect(xml.indexOf("<ignoredErrors>")).toBeGreaterThan(-1);
    expect(xml.indexOf("<ignoredErrors>")).toBeLessThan(xml.indexOf("<drawing"));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(withLogo as unknown as ExcelJS.Buffer);
    expect(workbook.getWorksheet("Report")!.getImages()).toHaveLength(1);
  });

  it("throws for an unknown sheet name", async () => {
    const base = await buildRowsXlsx<Row>({
      sheetName: "Report",
      columns: [{ header: "Qty", value: (r) => r.qty }],
      rows: [],
    });
    await expect(
      ignoreNumberStoredAsText(base, { Missing: ["A2:A3"] }),
    ).rejects.toThrow("Worksheet not found: Missing");
  });
});

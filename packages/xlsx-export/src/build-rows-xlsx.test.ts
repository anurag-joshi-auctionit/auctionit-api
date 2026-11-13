import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildRowsXlsx } from "./build-rows-xlsx.js";
import { exportFilename } from "./filename.js";

type SampleRow = { id: number; name: string };

describe("buildRowsXlsx", () => {
  it("writes a frozen bold header and one data row", async () => {
    const buffer = await buildRowsXlsx<SampleRow>({
      sheetName: "Samples",
      creator: "Test",
      columns: [
        { header: "ID", width: 10, value: (r) => r.id },
        { header: "Name", width: 20, value: (r) => r.name },
      ],
      rows: [{ id: 1, name: "Alpha" }],
    });

    const workbook = new ExcelJS.Workbook();
    // exceljs load typings disagree with Node Buffer generics across versions
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Samples");
    expect(sheet).toBeDefined();
    expect(sheet!.getRow(1).getCell(1).value).toBe("ID");
    expect(sheet!.getRow(1).getCell(2).value).toBe("Name");
    expect(sheet!.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(sheet!.getRow(2).getCell(1).value).toBe(1);
    expect(sheet!.getRow(2).getCell(2).value).toBe("Alpha");
    expect(sheet!.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("writes title and generated-at rows above the header when title is set", async () => {
    const buffer = await buildRowsXlsx<SampleRow>({
      sheetName: "Samples",
      title: "Sample Report [01 Sep 2026 to 28 Sep 2026]",
      generatedAt: "28 Sep 2026, 11:57:12 am",
      columns: [
        { header: "ID", width: 10, value: (r) => r.id },
        { header: "Name", width: 20, value: (r) => r.name },
      ],
      rows: [{ id: 1, name: "Alpha" }],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Samples")!;
    expect(sheet.getRow(1).getCell(1).value).toBe(
      "Sample Report [01 Sep 2026 to 28 Sep 2026]",
    );
    expect(sheet.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(sheet.getCell(1, 2).isMerged).toBe(true);
    expect(sheet.getRow(2).getCell(1).value).toBe(
      "Report generated at 28 Sep 2026, 11:57:12 am",
    );
    expect(sheet.getCell(2, 2).isMerged).toBe(true);
    expect(sheet.getRow(3).getCell(1).value).toBe("ID");
    expect(sheet.getRow(3).getCell(1).font?.bold).toBe(true);
    expect(sheet.getRow(4).getCell(1).value).toBe(1);
    expect(sheet.getRow(4).getCell(2).value).toBe("Alpha");
    expect(sheet.views?.[0]).toMatchObject({ state: "frozen", ySplit: 3 });
  });
});

describe("exportFilename", () => {
  it("formats prefix with YYYY-MM-DD", () => {
    expect(exportFilename("service-invoices", new Date("2026-07-24T12:00:00Z"))).toBe(
      "service-invoices-2026-07-24.xlsx",
    );
  });
});

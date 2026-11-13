import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { injectSheetLogo } from "./inject-sheet-logo.js";

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

async function streamedWorkbook(): Promise<Buffer> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream });
  for (const name of ["Summary", "Annexure"]) {
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 3 }],
    });
    sheet.mergeCells(1, 1, 1, 3);
    sheet.getCell(1, 1).value = `${name} title`;
    sheet.getRow(1).commit();
    sheet.addRow(["Generated"]).commit();
    sheet.addRow(["A", "B", "C"]).commit();
    sheet.addRow([1, 2, 3]).commit();
    sheet.commit();
  }
  await workbook.commit();
  await done;
  return Buffer.concat(chunks);
}

describe("injectSheetLogo", () => {
  it("anchors the image at A1 on each named sheet and keeps layout", async () => {
    const input = await streamedWorkbook();
    const output = await injectSheetLogo(input, {
      image: TINY_JPEG,
      sheetNames: ["Summary", "Annexure"],
      widthPx: 85,
      heightPx: 60,
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output as unknown as ExcelJS.Buffer);

    for (const name of ["Summary", "Annexure"]) {
      const sheet = workbook.getWorksheet(name)!;
      const images = sheet.getImages();
      expect(images).toHaveLength(1);
      expect(images[0]!.range.tl.nativeCol).toBe(0);
      expect(images[0]!.range.tl.nativeRow).toBe(0);
      expect(sheet.views?.[0]).toMatchObject({ state: "frozen", ySplit: 3 });
      expect(sheet.getCell(1, 2).isMerged).toBe(true);
      expect(sheet.getCell(1, 1).value).toBe(`${name} title`);
      expect(sheet.getRow(4).getCell(3).value).toBe(3);
    }
  });

  it("throws for an unknown sheet name", async () => {
    const input = await streamedWorkbook();
    await expect(
      injectSheetLogo(input, {
        image: TINY_JPEG,
        sheetNames: ["Missing"],
        widthPx: 10,
        heightPx: 10,
      }),
    ).rejects.toThrow("Worksheet not found: Missing");
  });
});

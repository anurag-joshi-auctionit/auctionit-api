import JSZip from "jszip";
import {
  columnLetter,
  findEntry,
  insertSheetElement,
  resolveSheetPaths,
  writeEntry,
} from "./xlsx-zip.js";

/** Last row index Excel supports; used to cover a column from a start row down. */
const MAX_EXCEL_ROW = 1048576;

/** Elements that must follow `<ignoredErrors>` in CT_Worksheet (ECMA-376 order). */
const ELEMENTS_AFTER_IGNORED_ERRORS = [
  "<smartTags",
  "<drawing",
  "<legacyDrawing",
  "<legacyDrawingHF",
  "<drawingHF",
  "<picture",
  "<oleObjects",
  "<controls",
  "<webPublishItems",
  "<tableParts",
  "<extLst",
  "</worksheet>",
];

/** e.g. `(2, 4)` → `B4:B1048576`. */
export function columnRangeFrom(columnIndex: number, startRow: number): string {
  const letter = columnLetter(columnIndex);
  return `${letter}${startRow}:${letter}${MAX_EXCEL_ROW}`;
}

/**
 * Suppresses Excel's "Number Stored as Text" warning (green corner mark) on
 * the given ranges. Cell values stay text; exceljs has no API for this.
 */
export async function ignoreNumberStoredAsText(
  xlsx: Buffer,
  rangesBySheet: Record<string, readonly string[]>,
): Promise<Buffer> {
  const entries = Object.entries(rangesBySheet).filter(([, r]) => r.length > 0);
  if (entries.length === 0) return xlsx;

  const zip = await JSZip.loadAsync(xlsx);
  const sheetPaths = await resolveSheetPaths(zip);

  for (const [name, ranges] of entries) {
    const sheetPath = sheetPaths.get(name);
    if (!sheetPath) throw new Error(`Worksheet not found: ${name}`);
    const sheetEntry = findEntry(zip, sheetPath);
    if (!sheetEntry) throw new Error(`Worksheet part missing: ${sheetPath}`);

    const element =
      `<ignoredErrors><ignoredError sqref="${ranges.join(" ")}"` +
      ` numberStoredAsText="1"/></ignoredErrors>`;
    const sheetBytes = await sheetEntry.async("nodebuffer");
    writeEntry(
      zip,
      sheetPath,
      insertSheetElement(sheetBytes, element, ELEMENTS_AFTER_IGNORED_ERRORS),
    );
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

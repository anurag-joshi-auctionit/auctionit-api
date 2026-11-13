import JSZip from "jszip";

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Zip entry lookup tolerant of a leading slash (archiver-written names). */
export function findEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
  return zip.file(path) ?? zip.file(`/${path}`);
}

export async function readText(zip: JSZip, path: string): Promise<string | null> {
  const entry = findEntry(zip, path);
  return entry ? entry.async("string") : null;
}

export function writeEntry(zip: JSZip, path: string, content: string | Buffer) {
  if (zip.file(`/${path}`)) zip.remove(`/${path}`);
  zip.file(path, content);
}

/** Maps worksheet name → zip path (e.g. `xl/worksheets/sheet2.xml`). */
export async function resolveSheetPaths(zip: JSZip): Promise<Map<string, string>> {
  const workbookXml = await readText(zip, "xl/workbook.xml");
  const relsXml = await readText(zip, "xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) {
    throw new Error("Invalid xlsx: workbook parts missing.");
  }

  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target) targets.set(id, target);
  }

  const paths = new Map<string, string>();
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const rid = /\br:id="([^"]+)"/.exec(tag)?.[1];
    const target = rid ? targets.get(rid) : undefined;
    if (name == null || !target) continue;
    const normalized = target.replace(/^\/+/, "").replace(/^xl\//, "");
    paths.set(unescapeXmlAttr(name), `xl/${normalized}`);
  }
  return paths;
}

/**
 * Inserts `element` before the first of `followers` found after `</sheetData>`,
 * working on bytes so large streamed sheets are never decoded into one JS string.
 */
export function insertSheetElement(
  sheet: Buffer,
  element: string,
  followers: readonly string[],
): Buffer {
  const sheetDataEnd = sheet.lastIndexOf("</sheetData>");
  const searchFrom = sheetDataEnd >= 0 ? sheetDataEnd : 0;
  let insertAt = -1;
  for (const marker of followers) {
    const idx = sheet.indexOf(marker, searchFrom);
    if (idx >= 0 && (insertAt < 0 || idx < insertAt)) insertAt = idx;
  }
  if (insertAt < 0) throw new Error("Invalid worksheet XML: no closing tag.");
  return Buffer.concat([
    sheet.subarray(0, insertAt),
    Buffer.from(element),
    sheet.subarray(insertAt),
  ]);
}

/** 1-based column index → Excel letters (1 → A, 27 → AA). */
export function columnLetter(index: number): string {
  let n = index;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

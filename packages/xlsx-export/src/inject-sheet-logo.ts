import JSZip from "jszip";
import {
  escapeXmlAttr,
  findEntry,
  insertSheetElement,
  readText,
  resolveSheetPaths,
  writeEntry,
} from "./xlsx-zip.js";

export type InjectSheetLogoOptions = {
  /** JPEG bytes. */
  image: Buffer;
  /** Worksheet names that receive the logo at A1. */
  sheetNames: readonly string[];
  widthPx: number;
  heightPx: number;
  /** Offset inside A1, in pixels. */
  offsetXPx?: number;
  offsetYPx?: number;
};

const EMU_PER_PX = 9525;
/** Alphanumeric only: exceljs ignores media names with other characters. */
const MEDIA_PATH = "xl/media/brandlogo.jpg";
const DRAWING_REL_ID = "rIdBrandLogo";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DRAWING_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const IMAGE_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const DRAWING_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.drawing+xml";

/** Elements that must follow `<drawing>` in CT_Worksheet (ECMA-376 order). */
const ELEMENTS_AFTER_DRAWING = [
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

function drawingXml(opts: {
  widthPx: number;
  heightPx: number;
  offsetXPx: number;
  offsetYPx: number;
}): string {
  const cx = Math.round(opts.widthPx * EMU_PER_PX);
  const cy = Math.round(opts.heightPx * EMU_PER_PX);
  const colOff = Math.round(opts.offsetXPx * EMU_PER_PX);
  const rowOff = Math.round(opts.offsetYPx * EMU_PER_PX);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<xdr:oneCellAnchor>" +
    `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${cx}" cy="${cy}"/>` +
    "<xdr:pic>" +
    '<xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    "</xdr:pic>" +
    "<xdr:clientData/>" +
    "</xdr:oneCellAnchor>" +
    "</xdr:wsDr>"
  );
}

function drawingRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${REL_NS}">` +
    `<Relationship Id="rId1" Type="${IMAGE_REL_TYPE}" Target="../media/${MEDIA_PATH.split("/").pop()}"/>` +
    "</Relationships>"
  );
}

function withSheetDrawingRel(existing: string | null, drawingFile: string): string {
  const rel = `<Relationship Id="${DRAWING_REL_ID}" Type="${DRAWING_REL_TYPE}" Target="../drawings/${escapeXmlAttr(drawingFile)}"/>`;
  if (!existing) {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<Relationships xmlns="${REL_NS}">${rel}</Relationships>`
    );
  }
  return existing.replace("</Relationships>", `${rel}</Relationships>`);
}

function withContentTypes(xml: string, drawingFiles: string[]): string {
  let out = xml;
  if (!/<Default\b[^>]*Extension="jpg"/i.test(out)) {
    out = out.replace(
      "</Types>",
      '<Default Extension="jpg" ContentType="image/jpeg"/></Types>',
    );
  }
  for (const file of drawingFiles) {
    const part = `/xl/drawings/${file}`;
    if (out.includes(`PartName="${part}"`)) continue;
    out = out.replace(
      "</Types>",
      `<Override PartName="${part}" ContentType="${DRAWING_CONTENT_TYPE}"/></Types>`,
    );
  }
  return out;
}

/**
 * Adds an image anchored at A1 to the named sheets of an existing xlsx.
 * exceljs' streaming writer cannot anchor images, so this post-processes
 * its output. Unmodified parts keep their original compression.
 */
export async function injectSheetLogo(
  xlsx: Buffer,
  options: InjectSheetLogoOptions,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(xlsx);
  const sheetPaths = await resolveSheetPaths(zip);

  writeEntry(zip, MEDIA_PATH, options.image);

  const drawingFiles: string[] = [];
  let drawingIndex = 1;
  const nextDrawingFile = () => {
    while (findEntry(zip, `xl/drawings/drawing${drawingIndex}.xml`)) {
      drawingIndex += 1;
    }
    return `drawing${drawingIndex}.xml`;
  };

  for (const name of options.sheetNames) {
    const sheetPath = sheetPaths.get(name);
    if (!sheetPath) throw new Error(`Worksheet not found: ${name}`);
    const sheetEntry = findEntry(zip, sheetPath);
    if (!sheetEntry) throw new Error(`Worksheet part missing: ${sheetPath}`);

    const drawingFile = nextDrawingFile();
    drawingFiles.push(drawingFile);
    writeEntry(
      zip,
      `xl/drawings/${drawingFile}`,
      drawingXml({
        widthPx: options.widthPx,
        heightPx: options.heightPx,
        offsetXPx: options.offsetXPx ?? 4,
        offsetYPx: options.offsetYPx ?? 4,
      }),
    );
    writeEntry(zip, `xl/drawings/_rels/${drawingFile}.rels`, drawingRelsXml());

    const sheetFile = sheetPath.split("/").pop()!;
    const relsPath = `xl/worksheets/_rels/${sheetFile}.rels`;
    writeEntry(
      zip,
      relsPath,
      withSheetDrawingRel(await readText(zip, relsPath), drawingFile),
    );

    const sheetBytes = await sheetEntry.async("nodebuffer");
    writeEntry(
      zip,
      sheetPath,
      insertSheetElement(
        sheetBytes,
        `<drawing r:id="${DRAWING_REL_ID}"/>`,
        ELEMENTS_AFTER_DRAWING,
      ),
    );
  }

  const contentTypes = await readText(zip, "[Content_Types].xml");
  if (!contentTypes) throw new Error("Invalid xlsx: content types missing.");
  writeEntry(zip, "[Content_Types].xml", withContentTypes(contentTypes, drawingFiles));

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

import {
  AlignmentType,
  LevelFormat,
  Paragraph,
  TextRun,
  type ILevelsOptions,
  type INumberingOptions,
} from "docx";
import type { RichTextNode } from "./rich-text.js";

export const BULLET_REFERENCE = "market-making-bullet";
export const ORDERED_REFERENCE = "market-making-ordered";

const MAX_LIST_LEVEL = 8;
const BULLET_GLYPHS = ["\u2022", "\u25E6", "\u25AA"];
const ORDERED_FORMATS = [
  LevelFormat.DECIMAL,
  LevelFormat.LOWER_LETTER,
  LevelFormat.LOWER_ROMAN,
];

function levelIndent(level: number) {
  return { left: 720 * (level + 1), hanging: 360 };
}

export function marketMakingNumbering(): INumberingOptions {
  const levels = (ordered: boolean): ILevelsOptions[] =>
    Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
      level,
      format: ordered
        ? ORDERED_FORMATS[level % ORDERED_FORMATS.length]!
        : LevelFormat.BULLET,
      text: ordered
        ? `%${level + 1}.`
        : BULLET_GLYPHS[level % BULLET_GLYPHS.length]!,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: levelIndent(level) } },
    }));
  return {
    config: [
      { reference: BULLET_REFERENCE, levels: levels(false) },
      { reference: ORDERED_REFERENCE, levels: levels(true) },
    ],
  };
}

export type RichTextDocxOptions = {
  /** Half-points, e.g. 30 = 15pt. */
  fontSize: number;
};

type ListContext = {
  reference: string;
  level: number;
  instance: number;
};

const HEADING_SIZE_BONUS: Record<number, number> = { 1: 8, 2: 4, 3: 2 };

function inlineRuns(
  nodes: RichTextNode[] | undefined,
  size: number,
  bold = false,
): TextRun[] {
  const runs: TextRun[] = [];
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") {
      runs.push(new TextRun({ break: 1, size }));
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const marks = new Set((node.marks ?? []).map((m) => m.type));
    runs.push(
      new TextRun({
        text: node.text,
        size,
        bold: bold || marks.has("bold"),
        italics: marks.has("italic"),
        underline: marks.has("underline") ? {} : undefined,
        strike: marks.has("strike"),
      }),
    );
  }
  return runs;
}

/** Converts the Market Making editor JSON into Word paragraphs. */
export function richTextToDocx(
  doc: RichTextNode | null | undefined,
  options: RichTextDocxOptions,
): Paragraph[] {
  const out: Paragraph[] = [];
  let listInstance = 0;

  const walkBlocks = (nodes: RichTextNode[] | undefined, list?: ListContext) => {
    for (const node of nodes ?? []) {
      switch (node.type) {
        case "paragraph":
          out.push(
            new Paragraph({
              alignment: AlignmentType.LEFT,
              spacing: { after: 120 },
              children: inlineRuns(node.content, options.fontSize),
              ...(list ? { indent: levelIndent(list.level) } : {}),
            }),
          );
          break;
        case "heading": {
          const level = Number(node.attrs?.level ?? 3);
          out.push(
            new Paragraph({
              spacing: { before: 120, after: 120 },
              children: inlineRuns(
                node.content,
                options.fontSize + (HEADING_SIZE_BONUS[level] ?? 0),
                true,
              ),
            }),
          );
          break;
        }
        case "bulletList":
        case "orderedList": {
          listInstance += 1;
          const ctx: ListContext = {
            reference:
              node.type === "orderedList" ? ORDERED_REFERENCE : BULLET_REFERENCE,
            level: list ? Math.min(list.level + 1, MAX_LIST_LEVEL) : 0,
            instance: listInstance,
          };
          for (const item of node.content ?? []) {
            if (item.type === "listItem") walkListItem(item, ctx);
          }
          break;
        }
        default:
          break;
      }
    }
  };

  const walkListItem = (item: RichTextNode, ctx: ListContext) => {
    let first = true;
    for (const child of item.content ?? []) {
      if (child.type === "paragraph" && first) {
        out.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 60 },
            numbering: {
              reference: ctx.reference,
              level: ctx.level,
              instance: ctx.instance,
            },
            children: inlineRuns(child.content, options.fontSize),
          }),
        );
        first = false;
      } else {
        walkBlocks([child], ctx);
      }
    }
  };

  walkBlocks(doc?.content);
  return out;
}

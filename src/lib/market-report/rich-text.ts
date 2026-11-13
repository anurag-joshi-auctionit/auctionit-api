import { z } from "zod";

/** Tiptap / ProseMirror JSON subset produced by the admin Market Making editor. */
export type RichTextMark = { type: "bold" | "italic" | "underline" | "strike" };

export type RichTextNode = {
  type:
    | "doc"
    | "paragraph"
    | "heading"
    | "bulletList"
    | "orderedList"
    | "listItem"
    | "text"
    | "hardBreak";
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: RichTextMark[];
  content?: RichTextNode[];
};

export const RICH_TEXT_MAX_NODES = 5000;
export const RICH_TEXT_MAX_TEXT_LENGTH = 50_000;

const markSchema = z.object({
  type: z.enum(["bold", "italic", "underline", "strike"]),
});

export const richTextNodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z.object({
    type: z.enum([
      "doc",
      "paragraph",
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
      "text",
      "hardBreak",
    ]),
    text: z.string().optional(),
    attrs: z.record(z.unknown()).optional(),
    marks: z.array(markSchema).optional(),
    content: z.array(richTextNodeSchema).optional(),
  }),
);

function measure(node: RichTextNode): { nodes: number; textLength: number } {
  let nodes = 1;
  let textLength = node.text?.length ?? 0;
  for (const child of node.content ?? []) {
    const m = measure(child);
    nodes += m.nodes;
    textLength += m.textLength;
  }
  return { nodes, textLength };
}

/** True when the document contains at least one non-whitespace character. */
export function hasRichTextContent(node: RichTextNode): boolean {
  if (node.text != null && node.text.trim().length > 0) return true;
  return (node.content ?? []).some(hasRichTextContent);
}

export function isRichTextWithinLimits(doc: RichTextNode): boolean {
  if (doc.type !== "doc") return false;
  const { nodes, textLength } = measure(doc);
  return nodes <= RICH_TEXT_MAX_NODES && textLength <= RICH_TEXT_MAX_TEXT_LENGTH;
}

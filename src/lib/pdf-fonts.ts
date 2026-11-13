import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PDF_FONT_REGULAR = "TimesNewRoman";
export const PDF_FONT_BOLD = "TimesNewRoman-Bold";

const fontsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/fonts",
);

export function registerTimesNewRoman(doc: {
  registerFont: (name: string, src: string) => unknown;
}): void {
  doc.registerFont(PDF_FONT_REGULAR, join(fontsDir, "TimesNewRoman.ttf"));
  doc.registerFont(PDF_FONT_BOLD, join(fontsDir, "TimesNewRomanBold.ttf"));
}

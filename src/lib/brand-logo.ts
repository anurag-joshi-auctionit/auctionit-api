import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOGO_RELATIVE_PATH = "public/logos/icom-logo.jpg";

/** Natural size of `icom-logo.jpg`. */
export const BRAND_LOGO_SIZE_PX = { width: 400, height: 284 } as const;

/** Absolute path of the brand logo (dev: `src/lib`, build: `dist/lib`, or cwd). */
export function resolveBrandLogoPath(): string | null {
  const fromModule = join(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
    LOGO_RELATIVE_PATH,
  );
  if (existsSync(fromModule)) return fromModule;
  const fromCwd = join(process.cwd(), LOGO_RELATIVE_PATH);
  return existsSync(fromCwd) ? fromCwd : null;
}

export function readBrandLogo(): Buffer | null {
  const path = resolveBrandLogoPath();
  return path ? readFileSync(path) : null;
}

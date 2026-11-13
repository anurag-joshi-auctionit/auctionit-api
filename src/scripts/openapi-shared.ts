import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The routers import env.ts, which requires DATABASE_URL. Nothing here
// connects to the database (the pg pool is lazy), so a placeholder is enough
// when generating docs on a machine/CI without a .env.
process.env.DATABASE_URL ??= "postgres://docs:docs@localhost:5432/docs";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const SPEC_PATH = join(apiRoot, "openapi.json");
export const UNDOCUMENTED_PATH = join(apiRoot, "src/openapi/undocumented.json");

export async function loadBuild() {
  await import("../openapi/paths/index.js");
  const { buildOpenApi } = await import("../openapi/document.js");
  const { routeDocs } = await import("../openapi/define.js");
  return { ...buildOpenApi(), routeDocs };
}

export function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function readUndocumented(): string[] {
  try {
    return JSON.parse(readFileSync(UNDOCUMENTED_PATH, "utf8")) as string[];
  } catch {
    return [];
  }
}

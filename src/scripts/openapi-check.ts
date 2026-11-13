/**
 * Fails when the API docs drift from the code:
 *  1. a live route has no docs in src/openapi/paths and is not in undocumented.json
 *  2. docs exist for a route that no longer exists (stale docs)
 *  3. undocumented.json lists a route that is now documented or gone (stale entry)
 *  4. the committed openapi.json differs from a fresh build
 *
 *   --prune   remove stale undocumented.json entries (never adds any)
 *   --seed    write every currently-undocumented route to undocumented.json (one-off bootstrap)
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  loadBuild,
  readUndocumented,
  serialize,
  SPEC_PATH,
  UNDOCUMENTED_PATH,
} from "./openapi-shared.js";

const args = new Set(process.argv.slice(2));
const { document, routes, routeDocs } = await loadBuild();

const live = new Set(routes.map((r) => r.key));
const allow = readUndocumented();
const allowSet = new Set(allow);

if (args.has("--seed")) {
  const missing = routes.filter((r) => !routeDocs.has(r.key)).map((r) => r.key);
  writeFileSync(UNDOCUMENTED_PATH, serialize(missing));
  console.log(`undocumented.json seeded with ${missing.length} routes.`);
  process.exit(0);
}

const errors: string[] = [];

const missingDocs = routes.filter((r) => !routeDocs.has(r.key) && !allowSet.has(r.key));
for (const r of missingDocs) {
  errors.push(
    `undocumented route: ${r.key} [${r.tag}] → document it in src/openapi/paths/<router-file>.ts`,
  );
}

for (const key of routeDocs.keys()) {
  if (!live.has(key)) errors.push(`stale docs: ${key} has docs but no matching route — remove or fix the path`);
}

const staleAllow = allow.filter((key) => !live.has(key) || routeDocs.has(key));
if (staleAllow.length > 0 && args.has("--prune")) {
  writeFileSync(UNDOCUMENTED_PATH, serialize(allow.filter((k) => !staleAllow.includes(k))));
  console.log(`pruned ${staleAllow.length} stale undocumented.json entries.`);
} else {
  for (const key of staleAllow) {
    errors.push(`stale undocumented.json entry: ${key}  → run \`pnpm openapi:check --prune\``);
  }
}

let committed = "";
try {
  committed = readFileSync(SPEC_PATH, "utf8");
} catch {
  // missing file reported below
}
if (committed !== serialize(document)) {
  errors.push("openapi.json is out of date → run `pnpm openapi:generate` and commit it");
}

const documented = routes.filter((r) => routeDocs.has(r.key)).length;
if (errors.length > 0) {
  console.error(`OpenAPI check failed (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error("\nSee docs/api/README.md for how to document a route.");
  process.exit(1);
}
console.log(`OpenAPI check passed: ${documented}/${routes.length} routes documented, ${routes.length - documented} pending.`);
process.exit(0);

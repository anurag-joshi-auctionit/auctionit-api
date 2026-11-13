/**
 * Builds the spec with only the given docs file(s) loaded and reports problems
 * for those routes. Writes nothing — safe to run while other docs files are
 * half-written.
 *
 *   pnpm --filter @auctionit/api openapi:verify items bidder-auctions
 */
import "./openapi-shared.js";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: openapi:verify <paths-file-name> [...more]");
  process.exit(2);
}
for (const name of names) {
  await import(`../openapi/paths/${name.replace(/\.ts$/, "")}.js`);
}
const { routeDocs } = await import("../openapi/define.js");
const { buildOpenApi } = await import("../openapi/document.js");

const { routes } = buildOpenApi();
const live = new Set(routes.map((r) => r.key));
const stale = [...routeDocs.keys()].filter((k) => !live.has(k));
for (const key of stale) console.error(`stale docs: ${key} has docs but no matching route`);
console.log(`${routeDocs.size} documented route(s) in ${names.join(", ")} built OK.`);
process.exit(stale.length > 0 ? 1 : 0);

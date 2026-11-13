import { writeFileSync } from "node:fs";
import { loadBuild, serialize, SPEC_PATH } from "./openapi-shared.js";

const { document, routes, routeDocs } = await loadBuild();
writeFileSync(SPEC_PATH, serialize(document));
const documented = routes.filter((r) => routeDocs.has(r.key)).length;
console.log(
  `openapi.json written: ${routes.length} operations, ${documented} fully documented, ${routes.length - documented} pending.`,
);
process.exit(0);

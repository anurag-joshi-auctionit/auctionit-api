import pg from "pg";
import { env } from "../../env.js";

/**
 * Refreshes planner statistics after the bulk loads. Without it the EMD
 * verify queries plan against empty-table stats and hit the statement timeout.
 */
async function main() {
  const started = Date.now();
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("ANALYZE");
    console.log(`ANALYZE done in ${Date.now() - started}ms.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

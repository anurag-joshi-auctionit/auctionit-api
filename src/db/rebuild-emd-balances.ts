import { db, pool } from "./index.js";
import { refreshBalanceCachesSql } from "../lib/emd/blocked.js";

/** Recomputes every bidder's Available / Blocked cache from the ledger. */
async function main() {
  const started = Date.now();
  const res = await db.execute(refreshBalanceCachesSql(null));
  console.log(`emd balances rebuilt for ${res.rowCount ?? 0} bidders in ${Date.now() - started}ms`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

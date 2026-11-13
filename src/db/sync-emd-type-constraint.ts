import { sql } from "drizzle-orm";
import { db, pool } from "./index.js";
import { EMD_TYPES, EMD_TYPE_TXN_TYPE, type EmdTxnType } from "./schema/emd-transactions.js";

const list = (side: EmdTxnType) =>
  EMD_TYPES.filter((t) => EMD_TYPE_TXN_TYPE[t] === side)
    .map((t) => `'${t}'`)
    .join(", ");

/**
 * Rebuilds `emd_transactions_txn_type_matches_emd_type` from `EMD_TYPE_TXN_TYPE`.
 *
 * `pnpm db:push` cannot do this: adding an `emd_type` value emits
 * `ALTER TYPE ... ADD VALUE`, which leaves the constraint untouched, and
 * drizzle-kit only diffs a check constraint's presence, not its body — so it
 * reports success while the constraint still rejects the new value. Run this
 * after any change to EMD_TYPES.
 */
async function main() {
  await db.execute(sql`
    ALTER TABLE emd_transactions
      DROP CONSTRAINT IF EXISTS emd_transactions_txn_type_matches_emd_type;
    ALTER TABLE emd_transactions
      ADD CONSTRAINT emd_transactions_txn_type_matches_emd_type CHECK (
        (txn_type = 'credit' AND emd_type IN (${sql.raw(list("credit"))}))
        OR (txn_type = 'debit' AND emd_type IN (${sql.raw(list("debit"))}))
      );
  `);
  console.log(`emd_type constraint synced: ${EMD_TYPES.length} types`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

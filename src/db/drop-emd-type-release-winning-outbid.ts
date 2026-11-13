import { sql } from "drizzle-orm";
import { db, pool } from "./index.js";
import { EMD_TYPES, EMD_TYPE_TXN_TYPE, type EmdTxnType } from "./schema/emd-transactions.js";

const REMOVED = "release_winning_outbid";

const list = (side: EmdTxnType) =>
  EMD_TYPES.filter((t) => EMD_TYPE_TXN_TYPE[t] === side)
    .map((t) => `'${t}'`)
    .join(", ");

/**
 * One-off, safe to re-run: removes `release_winning_outbid` from the `emd_type`
 * enum, which Postgres cannot do in place. Inside one transaction it checks no
 * row uses the value, drops the txn-type check constraint, renames the enum,
 * creates it again from `EMD_TYPES`, moves `emd_transactions.emd_type` onto it,
 * drops the old enum and puts the constraint back.
 *
 * It rewrites `emd_transactions` under an exclusive lock, so run it once per
 * database when nothing is writing EMD entries (before the next `pnpm db:push`,
 * which would otherwise try the same recreate).
 */
async function main() {
  await db.transaction(async (tx) => {
    const present = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'emd_type' AND e.enumlabel = ${REMOVED}
    `);
    if ((present.rows[0]?.n ?? 0) === 0) {
      console.log(`emd_type has no "${REMOVED}" value; nothing to do`);
      return;
    }
    await tx.execute(sql`LOCK TABLE emd_transactions IN ACCESS EXCLUSIVE MODE`);
    const used = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM emd_transactions WHERE emd_type::text = ${REMOVED}
    `);
    if ((used.rows[0]?.n ?? 0) > 0) {
      throw new Error(`${used.rows[0]!.n} emd_transactions rows still use "${REMOVED}"; convert them first`);
    }
    const others = await tx.execute<{ col: string }>(sql`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE udt_name = 'emd_type' AND NOT (table_name = 'emd_transactions' AND column_name = 'emd_type')
    `);
    if (others.rows.length > 0) {
      throw new Error(`other columns use emd_type: ${others.rows.map((r) => r.col).join(", ")}`);
    }
    await tx.execute(sql`
      ALTER TABLE emd_transactions DROP CONSTRAINT IF EXISTS emd_transactions_txn_type_matches_emd_type
    `);
    await tx.execute(sql`ALTER TYPE emd_type RENAME TO emd_type_old`);
    await tx.execute(
      sql.raw(`CREATE TYPE emd_type AS ENUM (${EMD_TYPES.map((t) => `'${t}'`).join(", ")})`),
    );
    await tx.execute(sql`
      ALTER TABLE emd_transactions ALTER COLUMN emd_type TYPE emd_type USING emd_type::text::emd_type
    `);
    await tx.execute(sql`DROP TYPE emd_type_old`);
    await tx.execute(sql`
      ALTER TABLE emd_transactions
        ADD CONSTRAINT emd_transactions_txn_type_matches_emd_type CHECK (
          (txn_type = 'credit' AND emd_type IN (${sql.raw(list("credit"))}))
          OR (txn_type = 'debit' AND emd_type IN (${sql.raw(list("debit"))}))
        )
    `);
    console.log(`emd_type recreated without "${REMOVED}" (${EMD_TYPES.length} values)`);
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

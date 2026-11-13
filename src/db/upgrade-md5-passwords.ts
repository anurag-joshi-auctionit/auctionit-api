/**
 * One-time: wrap every legacy MD5 password hash in bcrypt (algo `bcrypt_md5`)
 * so no unsalted MD5 stays in `users`. Users keep their passwords; each row
 * becomes plain bcrypt on the user's next successful login. Also clears
 * `previous_password` on those rows (it holds the prior MD5 hash and is never
 * read). Safe to re-run — only rows still `md5` are touched.
 *
 * Deploy the API code that verifies `bcrypt_md5` BEFORE running this.
 *
 * Run:  pnpm --filter @auctionit/api db:upgrade-md5-passwords
 *       APPLY=1 pnpm --filter @auctionit/api db:upgrade-md5-passwords
 */
import { and, asc, eq, gt } from "drizzle-orm";
import { wrapMd5Hash } from "../auth/hash.js";
import { env } from "../env.js";
import { db, pool } from "./index.js";
import { users } from "./schema/users.js";

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";
const BATCH = 500;
const PARALLEL = 8;

async function main() {
  const prefix = APPLY ? "" : "[DRY RUN] ";
  console.log(`\n${prefix}Upgrade MD5 password hashes to bcrypt\n`);
  console.log(`  NODE_ENV: ${env.NODE_ENV}\n`);

  let lastId = 0;
  let seen = 0;
  let upgraded = 0;
  let skipped = 0;

  for (;;) {
    const rows = await db
      .select({ id: users.id, password: users.password })
      .from(users)
      .where(and(eq(users.passwordAlgo, "md5"), gt(users.id, lastId)))
      .orderBy(asc(users.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;
    seen += rows.length;

    if (APPLY) {
      for (let i = 0; i < rows.length; i += PARALLEL) {
        const results = await Promise.all(
          rows.slice(i, i + PARALLEL).map(async (row) => {
            const wrapped = await wrapMd5Hash(row.password);
            // Guard: a login or reset mid-run already moved the row to bcrypt.
            const updated = await db
              .update(users)
              .set({
                password: wrapped,
                passwordAlgo: "bcrypt_md5",
                previousPassword: null,
              })
              .where(
                and(
                  eq(users.id, row.id),
                  eq(users.passwordAlgo, "md5"),
                  eq(users.password, row.password),
                ),
              )
              .returning({ id: users.id });
            return updated.length > 0;
          }),
        );
        for (const ok of results) {
          if (ok) upgraded++;
          else skipped++;
        }
      }
    }
    console.log(`  ${prefix}processed ${seen} user(s)…`);
  }

  if (!APPLY) {
    console.log(
      `\n  DRY_RUN — ${seen} user(s) still on MD5; no changes written. Re-run with APPLY=1 to write.\n`,
    );
  } else {
    console.log(
      `\n  Done. Upgraded ${upgraded}, skipped ${skipped} (changed during run).\n`,
    );
  }
}

main()
  .catch((e) => {
    console.error("MD5 password upgrade failed:", e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

import { sql } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "./index.js";

/**
 * Overwrite portal user + client/plant contact fields (and queued email-outbox
 * To/Cc) with internal test recipients so local/staging sends cannot hit
 * production contacts. Re-run after bidder/user/plant/client seeds.
 *
 * Run:  pnpm --filter @auctionit/api db:sanitize-contacts          (preview)
 *       APPLY=1 pnpm --filter @auctionit/api db:sanitize-contacts  (writes)
 */

const POC_NAME = "Anurag Joshi";
const POC_EMAIL = "anurag.joshi@auctionit.in";
const POC_MOBILE = "9311334992";
const BILLING_NAME = "Anurag Joshi";
const BILLING_EMAIL_TO = "kashish.kesharwani@auctionit.in";
const BILLING_EMAIL_CC =
  "anurag.joshi@auctionit.in, kumar.abhinav@auctionit.in";

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";
const DRY_RUN = !APPLY;

type CountRow = { n: number };
type SampleRow = { value: string | null; n: number };

function dbHost(): string {
  try {
    return new URL(env.DATABASE_URL).host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function printSamples(label: string, rows: SampleRow[]) {
  console.log(`    ${label}:`);
  if (rows.length === 0) {
    console.log("      (none)");
    return;
  }
  for (const r of rows) {
    console.log(`      ${r.n}×  ${r.value ?? "(null)"}`);
  }
}

async function sampleDistinct(
  table: string,
  column: string,
): Promise<SampleRow[]> {
  const res = await db.execute<SampleRow>(sql`
    SELECT ${sql.raw(column)} AS value, COUNT(*)::int AS n
    FROM ${sql.raw(table)}
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 5
  `);
  return res.rows;
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const res = await db.execute<CountRow>(query);
  return res.rows[0]?.n ?? 0;
}

async function main() {
  if (env.NODE_ENV === "production") {
    console.error(
      "\n  Refusing to run: NODE_ENV=production. This script is for local/staging copies only.\n",
    );
    process.exit(1);
  }

  const prefix = DRY_RUN ? "[DRY RUN] " : "";
  console.log(`\n${prefix}Sanitize portal user + client contact PII`);
  console.log(`  Database host: ${dbHost()}`);
  console.log(`  NODE_ENV:      ${env.NODE_ENV}\n`);
  console.log("  Replacement values:");
  console.log(
    `    Name:                    ${POC_NAME} (client/plant only; bidder user names kept)`,
  );
  console.log(`    Email:                   ${POC_EMAIL}`);
  console.log(`    Mobile:                  ${POC_MOBILE}`);
  console.log(`    Billing email To:        ${BILLING_EMAIL_TO}`);
  console.log(`    Billing email Cc:        ${BILLING_EMAIL_CC}\n`);

  const bidderUserTotal = await count(sql`
    SELECT COUNT(*)::int AS n FROM users WHERE bidder_id IS NOT NULL
  `);
  const bidderUserWouldChange = await count(sql`
    SELECT COUNT(*)::int AS n FROM users
    WHERE bidder_id IS NOT NULL
      AND (
        email_id IS DISTINCT FROM ${POC_EMAIL}
        OR phone_number IS DISTINCT FROM ${POC_MOBILE}
        OR secondary_phone_number IS DISTINCT FROM ${POC_MOBILE}
        OR whatsapp_number IS DISTINCT FROM ${POC_MOBILE}
        OR whatsapp_sec_number IS DISTINCT FROM ${POC_MOBILE}
      )
  `);

  const clientUserTotal = await count(sql`
    SELECT COUNT(DISTINCT u.id)::int AS n
    FROM users u
    INNER JOIN user_clients uc ON uc.user_id = u.id
  `);
  const clientUserWouldChange = await count(sql`
    SELECT COUNT(DISTINCT u.id)::int AS n
    FROM users u
    INNER JOIN user_clients uc ON uc.user_id = u.id
    WHERE u.name IS DISTINCT FROM ${POC_NAME}
       OR u.email_id IS DISTINCT FROM ${POC_EMAIL}
       OR u.phone_number IS DISTINCT FROM ${POC_MOBILE}
       OR u.secondary_phone_number IS DISTINCT FROM ${POC_MOBILE}
       OR u.whatsapp_number IS DISTINCT FROM ${POC_MOBILE}
       OR u.whatsapp_sec_number IS DISTINCT FROM ${POC_MOBILE}
  `);

  const plantTotal = await count(
    sql`SELECT COUNT(*)::int AS n FROM plant_locations`,
  );
  const plantWouldChange = await count(sql`
    SELECT COUNT(*)::int AS n FROM plant_locations
    WHERE poc_name IS DISTINCT FROM ${POC_NAME}
       OR poc_email IS DISTINCT FROM ${POC_EMAIL}
       OR poc_phone IS DISTINCT FROM ${POC_MOBILE}
       OR billing_name IS DISTINCT FROM ${BILLING_NAME}
       OR billing_email_to IS DISTINCT FROM ${BILLING_EMAIL_TO}
       OR billing_email_cc IS DISTINCT FROM ${BILLING_EMAIL_CC}
  `);

  const clientTotal = await count(
    sql`SELECT COUNT(*)::int AS n FROM clients`,
  );
  const clientWouldChange = await count(sql`
    SELECT COUNT(*)::int AS n FROM clients
    WHERE email IS DISTINCT FROM ${POC_EMAIL}
       OR phone IS DISTINCT FROM ${POC_MOBILE}
  `);

  const outboxTotal = await count(sql`
    SELECT COUNT(*)::int AS n FROM notification_email_logs
    WHERE status IN ('queued', 'sending')
  `);
  const outboxWouldChange = await count(sql`
    SELECT COUNT(*)::int AS n FROM notification_email_logs
    WHERE status IN ('queued', 'sending')
      AND (
        email_to IS DISTINCT FROM (
          CASE WHEN source_type = 'service_invoice'
            THEN ${BILLING_EMAIL_TO}
            ELSE ${POC_EMAIL}
          END
        )
        OR email_cc IS DISTINCT FROM ${BILLING_EMAIL_CC}
      )
  `);

  console.log("  Row counts (would change / total):");
  console.log(
    `    users (bidder):          ${bidderUserWouldChange} / ${bidderUserTotal}  (already matching: ${bidderUserTotal - bidderUserWouldChange})`,
  );
  console.log(
    `    users (client portal):   ${clientUserWouldChange} / ${clientUserTotal}  (already matching: ${clientUserTotal - clientUserWouldChange})`,
  );
  console.log(
    `    plant_locations:         ${plantWouldChange} / ${plantTotal}  (already matching: ${plantTotal - plantWouldChange})`,
  );
  console.log(
    `    clients:                 ${clientWouldChange} / ${clientTotal}  (already matching: ${clientTotal - clientWouldChange})`,
  );
  console.log(
    `    notification_email_logs: ${outboxWouldChange} / ${outboxTotal} queued|sending  (already matching: ${outboxTotal - outboxWouldChange})`,
  );

  console.log("\n  Current distinct samples (top 5):");
  printSamples(
    "users.email_id (bidder)",
    (
      await db.execute<SampleRow>(sql`
        SELECT email_id AS value, COUNT(*)::int AS n
        FROM users
        WHERE bidder_id IS NOT NULL
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 5
      `)
    ).rows,
  );
  printSamples(
    "users.phone_number (bidder)",
    (
      await db.execute<SampleRow>(sql`
        SELECT phone_number AS value, COUNT(*)::int AS n
        FROM users
        WHERE bidder_id IS NOT NULL
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 5
      `)
    ).rows,
  );
  printSamples(
    "plant_locations.poc_email",
    await sampleDistinct("plant_locations", "poc_email"),
  );
  printSamples("clients.email", await sampleDistinct("clients", "email"));
  printSamples(
    "outbox email_to (queued|sending)",
    (
      await db.execute<SampleRow>(sql`
        SELECT email_to AS value, COUNT(*)::int AS n
        FROM notification_email_logs
        WHERE status IN ('queued', 'sending')
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 5
      `)
    ).rows,
  );

  if (DRY_RUN) {
    console.log(
      "\n  DRY_RUN — no changes written. Re-run with APPLY=1 to write.\n",
    );
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    const bidderUsersRes = await tx.execute(sql`
      UPDATE users SET
        email_id = ${POC_EMAIL},
        phone_number = ${POC_MOBILE},
        secondary_phone_number = ${POC_MOBILE},
        whatsapp_number = ${POC_MOBILE},
        whatsapp_sec_number = ${POC_MOBILE}
      WHERE bidder_id IS NOT NULL
    `);
    console.log(
      `\n  Updated users (bidder): ${bidderUsersRes.rowCount ?? 0}`,
    );

    const clientUsersRes = await tx.execute(sql`
      UPDATE users u SET
        name = ${POC_NAME},
        email_id = ${POC_EMAIL},
        phone_number = ${POC_MOBILE},
        secondary_phone_number = ${POC_MOBILE},
        whatsapp_number = ${POC_MOBILE},
        whatsapp_sec_number = ${POC_MOBILE}
      FROM user_clients uc
      WHERE uc.user_id = u.id
    `);
    console.log(
      `  Updated users (client portal): ${clientUsersRes.rowCount ?? 0}`,
    );

    const plantsRes = await tx.execute(sql`
      UPDATE plant_locations SET
        poc_name = ${POC_NAME},
        poc_email = ${POC_EMAIL},
        poc_phone = ${POC_MOBILE},
        billing_name = ${BILLING_NAME},
        billing_email_to = ${BILLING_EMAIL_TO},
        billing_email_cc = ${BILLING_EMAIL_CC}
    `);
    console.log(`  Updated plant_locations: ${plantsRes.rowCount ?? 0}`);

    const clientsRes = await tx.execute(sql`
      UPDATE clients SET
        email = ${POC_EMAIL},
        phone = ${POC_MOBILE}
    `);
    console.log(`  Updated clients: ${clientsRes.rowCount ?? 0}`);

    const outboxRes = await tx.execute(sql`
      UPDATE notification_email_logs
      SET email_to = CASE
            WHEN source_type = 'service_invoice' THEN ${BILLING_EMAIL_TO}
            ELSE ${POC_EMAIL}
          END,
          email_cc = ${BILLING_EMAIL_CC}
      WHERE status IN ('queued', 'sending')
    `);
    console.log(
      `  Updated notification_email_logs (queued|sending): ${outboxRes.rowCount ?? 0}\n`,
    );
  });

  process.exit(0);
}

main().catch((e) => {
  console.error("Sanitize contact PII failed:", e);
  process.exit(1);
});

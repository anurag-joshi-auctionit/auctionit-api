/**
 * One-time backfill: ensure every bidder with legacy POC data has a linked
 * login user, and fill empty user contact fields from `bidders.poc_*` before
 * those columns are dropped. Uses raw SQL so it works while columns still
 * exist in the database.
 *
 * Run:  pnpm --filter @auctionit/api db:backfill-bidder-users-from-poc
 *       APPLY=1 pnpm --filter @auctionit/api db:backfill-bidder-users-from-poc
 *
 * Then on local/staging: APPLY=1 pnpm --filter @auctionit/api db:sanitize-contacts
 */
import { eq, max, sql } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "./index.js";
import { ROLE_CODES, roles } from "./schema/roles.js";
import { users } from "./schema/users.js";
import { hashPasswordForStorage } from "../auth/hash.js";
import { generateTemporaryPassword } from "../lib/auth/password-rules.js";
import { formatUtcNow } from "@auctionit/lib/date";

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";
const SYSTEM_USER_ID = 1;

type BidderPocRow = {
  id: number;
  company_name: string;
  is_active: boolean;
  poc_name: string | null;
  poc_email: string | null;
  poc_phone_primary: string | null;
  poc_phone_secondary: string | null;
  poc_phone_whatsapp: string | null;
};

function orNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function clip(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

function slugLogin(companyName: string, bidderId: number): string {
  const base = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 30);
  return `${base || "bidder"}${bidderId}`.slice(0, 50);
}

async function main() {
  const prefix = APPLY ? "" : "[DRY RUN] ";
  console.log(`\n${prefix}Backfill bidder login users from POC\n`);
  console.log(`  NODE_ENV: ${env.NODE_ENV}\n`);

  // Detect whether legacy POC columns still exist.
  const colCheck = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'bidders'
        AND column_name = 'poc_email'
    ) AS exists
  `);
  if (!colCheck.rows[0]?.exists) {
    console.log(
      "  bidders.poc_* columns already removed — nothing to backfill from POC.\n",
    );
    process.exit(0);
  }

  const [bidderRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, ROLE_CODES.bidder))
    .limit(1);
  if (!bidderRole) {
    console.error("Bidder role not found.");
    process.exit(1);
  }

  const bidderRes = await db.execute<BidderPocRow>(sql`
    SELECT
      id,
      company_name,
      is_active,
      poc_name,
      poc_email,
      poc_phone_primary,
      poc_phone_secondary,
      poc_phone_whatsapp
    FROM bidders
  `);
  const bidderRows = bidderRes.rows;

  const linkedUsers = await db
    .select({
      id: users.id,
      bidderId: users.bidderId,
      name: users.name,
      emailId: users.emailId,
      phoneNumber: users.phoneNumber,
      secondaryPhoneNumber: users.secondaryPhoneNumber,
      whatsappNumber: users.whatsappNumber,
    })
    .from(users)
    .where(sql`${users.bidderId} IS NOT NULL`);

  const userByBidder = new Map(
    linkedUsers
      .filter((u) => u.bidderId != null)
      .map((u) => [u.bidderId as number, u]),
  );

  let created = 0;
  let filled = 0;
  let skippedNoPoc = 0;
  let conflicts = 0;
  const conflictLines: string[] = [];
  const now = formatUtcNow();

  for (const b of bidderRows) {
    const existing = userByBidder.get(b.id);
    const pocName = orNull(b.poc_name);
    const pocEmail = orNull(b.poc_email);
    const pocPhone = orNull(b.poc_phone_primary);
    const pocSecondary = orNull(b.poc_phone_secondary);
    const pocWhatsapp = orNull(b.poc_phone_whatsapp);
    const hasPoc = Boolean(pocName || pocEmail || pocPhone);

    if (!existing) {
      if (!hasPoc) {
        skippedNoPoc++;
        continue;
      }

      const name = clip(pocName || b.company_name || `Bidder ${b.id}`, 100);
      let login = slugLogin(b.company_name, b.id);
      const [loginTaken] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.userLoginName, login))
        .limit(1);
      if (loginTaken) {
        login = `b${b.id}_${Date.now().toString(36)}`.slice(0, 50);
      }

      const email = pocEmail ? clip(pocEmail, 100) : null;

      if (!APPLY) {
        console.log(
          `  would create user for bidder #${b.id} login=${login} email=${email ?? "(none)"}`,
        );
        created++;
        continue;
      }

      const [maxRow] = await db.select({ value: max(users.id) }).from(users);
      const userId = (maxRow?.value ?? 0) + 1;
      const tempPassword = generateTemporaryPassword();
      const { hash, algo } = await hashPasswordForStorage(tempPassword);

      try {
        await db.insert(users).values({
          id: userId,
          userLoginName: login,
          name,
          emailId: email,
          phoneNumber: pocPhone,
          secondaryPhoneNumber: pocSecondary,
          whatsappNumber: pocWhatsapp,
          password: hash,
          passwordAlgo: algo,
          passwordChanged: false,
          roleId: bidderRole.id,
          bidderId: b.id,
          isActive: b.is_active,
          createdAt: now,
          createdBy: SYSTEM_USER_ID,
        });
        created++;
        console.log(`  created user #${userId} for bidder #${b.id} (${login})`);
      } catch (e) {
        conflicts++;
        const msg = e instanceof Error ? e.message : String(e);
        conflictLines.push(`bidder #${b.id}: ${msg}`);
      }
      continue;
    }

    const patch: Partial<typeof users.$inferInsert> = {};
    if (!orNull(existing.name) && pocName) patch.name = clip(pocName, 100);
    if (!orNull(existing.emailId) && pocEmail)
      patch.emailId = clip(pocEmail, 100);
    if (!orNull(existing.phoneNumber) && pocPhone)
      patch.phoneNumber = pocPhone;
    if (!orNull(existing.secondaryPhoneNumber) && pocSecondary)
      patch.secondaryPhoneNumber = pocSecondary;
    if (!orNull(existing.whatsappNumber) && pocWhatsapp)
      patch.whatsappNumber = pocWhatsapp;

    if (Object.keys(patch).length === 0) continue;

    if (!APPLY) {
      console.log(`  would fill user #${existing.id} bidder #${b.id}`, patch);
      filled++;
      continue;
    }

    await db
      .update(users)
      .set({
        ...patch,
        lastUpdatedAt: now,
        lastUpdatedBy: SYSTEM_USER_ID,
      })
      .where(eq(users.id, existing.id));
    filled++;
  }

  const stillMissing = await db.execute<{ id: number; company_name: string }>(
    sql`
      SELECT b.id, b.company_name
      FROM bidders b
      LEFT JOIN users u ON u.bidder_id = b.id
      WHERE u.id IS NULL
    `,
  );

  console.log(`\n  Created users:     ${created}`);
  console.log(`  Filled contacts:   ${filled}`);
  console.log(`  Skipped (no POC):  ${skippedNoPoc}`);
  console.log(`  Conflicts:         ${conflicts}`);
  console.log(
    `  Bidders still without user: ${stillMissing.rows.length}`,
  );
  if (conflictLines.length) {
    console.log("\n  Conflicts:");
    for (const line of conflictLines.slice(0, 20)) console.log(`    ${line}`);
  }
  if (stillMissing.rows.length) {
    console.log("\n  Sample bidders without user:");
    for (const r of stillMissing.rows.slice(0, 10)) {
      console.log(`    #${r.id} ${r.company_name}`);
    }
  }

  if (!APPLY) {
    console.log(
      "\n  DRY_RUN — no changes written. Re-run with APPLY=1 to write.\n",
    );
  } else {
    console.log("\n  Done. On local/staging, run sanitize-contacts next.\n");
  }
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});

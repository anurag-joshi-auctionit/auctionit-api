import { sql } from "drizzle-orm";
import { db, pool } from "../index.js";

/**
 * Fixture for the live-bid stress driver: N published auctions, each with M lots
 * that are open right now (IST), plus an auction-wide bidder map so every bidder
 * in the pool can bid any lot.
 *
 * Run: pnpm --filter @auctionit/api seed:stress-auctions
 *
 * Optional env overrides:
 *   AUCTIONS       auctions to create                  (default: 10)
 *   LOTS           lots per auction                    (default: 1)
 *   CLIENT_ID      client to attach the auctions to    (default: first active)
 *   BIDDER_LIMIT   size of the mapped bidder pool      (default: 200)
 *   LEAD_MIN       minutes ago the lots opened         (default: 2)
 *   DURATION_MIN   minutes from now the lots close     (default: 360)
 *   START_PRICE    lot start bid price                 (default: 1000)
 *   INCREMENT      lot bid increment                   (default: 100)
 *   CLEANUP        "1" to drop previous STRESS-* fixtures first
 *   CLEANUP_ONLY   "1" to drop previous fixtures and exit
 *
 * DURATION_MIN defaults to 6 hours on purpose: anti-snipe extension and lot
 * staggering only fire inside the client's last-bid window (minutes), so a far
 * end time keeps the run measuring the bid path itself. Drop it to a couple of
 * minutes to deliberately stress the extend + snapshot-broadcast path instead.
 */

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const flag = (v: string | undefined) => v === "1" || v === "true";

// Same reserved band as seed-live-auction: above every legacy MSSQL id, so the
// bulk loader can never collide with a fixture row and cleanup is a range scan.
const TEST_ID_BASE = 1_900_000_000;

const AUCTION_PREFIX = "STRESS-";

async function cleanup(): Promise<void> {
  const res = await db.execute<{ auction_id: number }>(sql`
    SELECT auction_id FROM auctions
    WHERE auction_number LIKE ${`${AUCTION_PREFIX}%`}
      AND auction_id >= ${TEST_ID_BASE}
  `);
  const ids = res.rows.map((r) => r.auction_id);
  if (ids.length === 0) {
    console.log("  Cleanup: no previous stress fixtures found.");
    return;
  }
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  await db.transaction(async (tx) => {
    // Children first — these tables carry FKs back to auctions/lots.
    await tx.execute(sql`DELETE FROM auction_bid_logs WHERE auction_id IN (${idList})`);
    await tx.execute(sql`DELETE FROM auction_bids WHERE auction_id IN (${idList})`);
    await tx.execute(sql`DELETE FROM auction_proxy_bids WHERE auction_id IN (${idList})`);
    await tx.execute(sql`DELETE FROM auction_lot_bidder_maps WHERE auction_id IN (${idList})`);
    await tx.execute(sql`DELETE FROM auction_lots WHERE auction_id IN (${idList})`);
    await tx.execute(sql`DELETE FROM auctions WHERE auction_id IN (${idList})`);
  });
  console.log(`  Cleanup: removed ${ids.length} previous stress auction(s).`);
}

async function main() {
  const cleanupOnly = flag(process.env.CLEANUP_ONLY);
  if (cleanupOnly || flag(process.env.CLEANUP)) {
    console.log("\n🧹 Stress fixture cleanup\n");
    await cleanup();
    if (cleanupOnly) {
      console.log("");
      await pool.end();
      process.exit(0);
    }
  }

  const auctionCount = num(process.env.AUCTIONS, 10);
  const lotsPerAuction = num(process.env.LOTS, 1);
  const bidderLimit = num(process.env.BIDDER_LIMIT, 200);
  const leadMin = num(process.env.LEAD_MIN, 2);
  const durationMin = num(process.env.DURATION_MIN, 360);
  const startPrice = num(process.env.START_PRICE, 1000);
  const increment = num(process.env.INCREMENT, 100);
  const clientIdOverride = process.env.CLIENT_ID
    ? num(process.env.CLIENT_ID, 0)
    : null;

  const summary = await db.transaction(async (tx) => {
    const clientRow = (
      await tx.execute<{ id: number; company_name: string }>(
        clientIdOverride
          ? sql`SELECT id, company_name FROM clients WHERE id = ${clientIdOverride} LIMIT 1`
          : sql`SELECT id, company_name FROM clients WHERE is_active = true ORDER BY id LIMIT 1`,
      )
    ).rows[0];
    if (!clientRow) throw new Error("No client found (set CLIENT_ID).");
    const clientId = clientRow.id;

    const staff = (
      await tx.execute<{ id: number }>(sql`
        SELECT id FROM users WHERE bidder_id IS NULL AND is_active = true
        ORDER BY id LIMIT 1
      `)
    ).rows[0];
    if (!staff) throw new Error("No staff user found for created_by.");
    const createdBy = staff.id;

    // Only bidders with an active login user can hold a session and bid.
    const bidderRows = (
      await tx.execute<{ bidder_id: number; user_id: number }>(sql`
        SELECT b.id AS bidder_id, u.id AS user_id
        FROM bidders b
        JOIN users u ON u.bidder_id = b.id AND u.is_active = true
        WHERE b.is_active = true
        ORDER BY b.id DESC
        LIMIT ${bidderLimit}
      `)
    ).rows;
    if (bidderRows.length === 0) {
      throw new Error(
        "No mappable bidders (need active bidders with an active login user).",
      );
    }

    const nextId = async (table: string, col = "id") =>
      Number(
        (
          await tx.execute<{ n: number }>(
            sql`SELECT COALESCE(MAX(${sql.raw(col)}), ${TEST_ID_BASE}) + 1 AS n
                FROM ${sql.raw(table)} WHERE ${sql.raw(col)} >= ${TEST_ID_BASE}`,
          )
        ).rows[0]!.n,
      );
    let auctionId = await nextId("auctions", "auction_id");
    let lotId = await nextId("auction_lots");
    let mapId = await nextId("auction_lot_bidder_maps");

    const uom = (
      await tx.execute<{ id: number }>(sql`
        SELECT id FROM uoms WHERE upper(replace(code, ' ', '')) IN ('MT','RSPMT','AEDPMT')
        ORDER BY id LIMIT 1
      `)
    ).rows[0];

    const auctions: { auctionId: number; lotIds: number[] }[] = [];

    for (let a = 0; a < auctionCount; a++) {
      const thisAuctionId = auctionId++;
      await tx.execute(sql`
        INSERT INTO auctions
          (auction_id, client_id, auction_number, auction_type, auction_date,
           published_at, status, is_active, is_no_bid_extension, no_bid_extension_count_max,
           is_start_bid_price_plus_increment, is_rank_based, created_at, created_by)
        VALUES
          (${thisAuctionId}, ${clientId}, ${`${AUCTION_PREFIX}${thisAuctionId}`}, 'forward',
           (now() AT TIME ZONE 'Asia/Kolkata')::date,
           now(), 'published', true, false, 0, false, false, now(), ${createdBy})
      `);

      const lotIds: number[] = [];
      const lotValues = [];
      for (let i = 1; i <= lotsPerAuction; i++) {
        const thisLotId = lotId++;
        lotIds.push(thisLotId);
        lotValues.push(sql`(
          ${thisLotId}, ${clientId}, ${thisAuctionId}, ${`Lot ${i}`}, 100, ${startPrice},
          ${uom?.id ?? null}, ${increment}, ${i},
          ((now() AT TIME ZONE 'Asia/Kolkata') - make_interval(mins => ${leadMin}))::time,
          ((now() AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => ${durationMin}))::time,
          1, true, true, false, now(), ${createdBy}
        )`);
      }
      await tx.execute(sql`
        INSERT INTO auction_lots
          (id, client_id, auction_id, lot_number, quantity, start_bid_price, uom_id,
           bid_increment, display_order, start_time, end_time, status, is_approved,
           is_active, is_no_bid_extension, created_at, created_by)
        VALUES ${sql.join(lotValues, sql`, `)}
      `);

      // lot_id NULL = auction-wide map, so the pool can bid every lot.
      const mapValues = bidderRows.map(
        (b) => sql`(
          ${mapId++}, ${thisAuctionId}, ${clientId}, ${b.bidder_id}, NULL, false,
          true, now(), ${createdBy}
        )`,
      );
      await tx.execute(sql`
        INSERT INTO auction_lot_bidder_maps
          (id, auction_id, client_id, bidder_id, lot_id, is_emd_with_client,
           is_active, created_at, created_by)
        VALUES ${sql.join(mapValues, sql`, `)}
      `);

      auctions.push({ auctionId: thisAuctionId, lotIds });
    }

    const times = (
      await tx.execute<{ starts: string; ends: string }>(sql`
        SELECT
          to_char((now() AT TIME ZONE 'Asia/Kolkata') - make_interval(mins => ${leadMin}), 'HH24:MI:SS') AS starts,
          to_char((now() AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => ${durationMin}), 'HH24:MI:SS') AS ends
      `)
    ).rows[0]!;

    const settings = (
      await tx.execute(sql`
        SELECT is_last_bid_extension, last_bid_extension_window, last_bid_extension_interval,
               is_staggered
        FROM clients WHERE id = ${clientId}
      `)
    ).rows[0];

    return {
      auctions,
      client: { id: clientId, name: clientRow.company_name },
      bidders: bidderRows,
      startsIst: times.starts,
      endsIst: times.ends,
      settings,
    };
  });

  const auctionIds = summary.auctions.map((a) => a.auctionId);
  const lotIds = summary.auctions.flatMap((a) => a.lotIds);

  console.log("\n✅ Stress fixture created\n");
  console.log(`  Client      #${summary.client.id}  ${summary.client.name}`);
  console.log(
    `  Auctions    ${auctionIds.length} × ${lotsPerAuction} lot(s) = ${lotIds.length} lots`,
  );
  console.log(
    `  Open        ${summary.startsIst} → ${summary.endsIst} IST (today)`,
  );
  console.log(`  Bidder pool ${summary.bidders.length}`);
  console.log(`  Lot economics  start ${startPrice}  ·  increment ${increment}`);
  console.log(`  Client live-bid settings:`, summary.settings);

  console.log("\n  Run the stress driver with:\n");
  console.log(`    AUCTION_IDS=${auctionIds.join(",")} \\`);
  console.log(`    LOT_IDS=${lotIds.join(",")} \\`);
  console.log(
    `    BIDDER_IDS=${summary.bidders.map((b) => b.bidder_id).join(",")} \\`,
  );
  console.log(
    `    USER_IDS=${summary.bidders.map((b) => b.user_id).join(",")} \\`,
  );
  console.log(
    `    TARGET_RPS=500 DURATION_SEC=30 pnpm --filter @auctionit/api live:stress\n`,
  );
  console.log(
    `  Or let the driver discover this fixture itself (it reads STRESS-* auctions):\n`,
  );
  console.log(
    `    TARGET_RPS=500 DURATION_SEC=30 pnpm --filter @auctionit/api live:stress\n`,
  );

  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("Failed to seed stress fixture:", e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

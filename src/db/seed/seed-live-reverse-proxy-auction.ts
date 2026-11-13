import { sql } from "drizzle-orm";
import { db } from "../index.js";

/**
 * Create ONE live REVERSE auction ready for proxy (auto-bid) testing.
 *
 * Run: pnpm --filter @auctionit/api seed:live-reverse-proxy-auction
 *
 * Same env overrides as seed-live-proxy-auction.ts. Pricing is descending:
 *   startBidPrice = ceiling (SBP)
 *   bidLimit      = floor (must be < SBP)
 *   PROXY_MAX_*   = minimum acceptable prices (lower is more aggressive)
 */

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const truthy = (v: string | undefined) =>
  v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";

async function main() {
  const lots = num(process.env.LOTS, 3);
  const leadMin = num(process.env.LEAD_MIN, 5);
  const durationMin = num(process.env.DURATION_MIN, 30);
  const bidderLimit = Math.max(2, num(process.env.BIDDER_LIMIT, 5));
  const seedProxies = truthy(process.env.SEED_PROXIES);
  const clientIdOverride = process.env.CLIENT_ID
    ? num(process.env.CLIENT_ID, 0)
    : null;
  const bidderIdsOverride = process.env.BIDDER_IDS
    ? process.env.BIDDER_IDS.split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : null;

  if (bidderIdsOverride && bidderIdsOverride.length < 2) {
    throw new Error("BIDDER_IDS must list at least 2 bidders for proxy testing.");
  }

  const summary = await db.transaction(async (tx) => {
    const clientRow = clientIdOverride
      ? (
          await tx.execute<{ id: number; company_name: string }>(sql`
            SELECT id, company_name FROM clients WHERE id = ${clientIdOverride} LIMIT 1
          `)
        ).rows[0]
      : (
          await tx.execute<{ id: number; company_name: string }>(sql`
            SELECT id, company_name FROM clients
            WHERE is_active = true ORDER BY id LIMIT 1
          `)
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

    const bidderRows = (
      await tx.execute<{
        bidder_id: number;
        company_name: string;
        login: string;
        user_id: number;
      }>(
        bidderIdsOverride
          ? sql`
              SELECT b.id AS bidder_id, b.company_name,
                     u.user_login_name AS login, u.id AS user_id
              FROM bidders b
              JOIN users u ON u.bidder_id = b.id AND u.is_active = true
              WHERE b.id IN (${sql.join(
                bidderIdsOverride.map((id) => sql`${id}`),
                sql`, `,
              )})
              ORDER BY b.id
            `
          : sql`
              SELECT b.id AS bidder_id, b.company_name,
                     u.user_login_name AS login, u.id AS user_id
              FROM bidders b
              JOIN users u ON u.bidder_id = b.id AND u.is_active = true
              WHERE b.is_active = true
              ORDER BY b.id DESC
              LIMIT ${bidderLimit}
            `,
      )
    ).rows;
    if (bidderRows.length < 2) {
      throw new Error(
        "Need at least 2 mappable bidders with active login users (set BIDDER_IDS).",
      );
    }

    const TEST_ID_BASE = 1_900_000_000;
    const nextId = async (table: string, col = "id") =>
      Number(
        (
          await tx.execute<{ n: number }>(
            sql`SELECT COALESCE(MAX(${sql.raw(col)}), ${TEST_ID_BASE}) + 1 AS n
                FROM ${sql.raw(table)} WHERE ${sql.raw(col)} >= ${TEST_ID_BASE}`,
          )
        ).rows[0]!.n,
      );
    const auctionId = await nextId("auctions", "auction_id");
    let lotId = await nextId("auction_lots");
    let mapId = await nextId("auction_lot_bidder_maps");
    const firstLotId = lotId;

    const startBidPrice = 1000;
    const bidIncrement = 100;
    const bidLimit = 100; // floor — must be < SBP for reverse

    await tx.execute(sql`
      INSERT INTO auctions
        (auction_id, client_id, auction_number, auction_type, auction_date,
         published_at, status, is_active, is_no_bid_extension, no_bid_extension_count_max,
         is_start_bid_price_plus_increment, is_rank_based, created_at, created_by)
      VALUES
        (${auctionId}, ${clientId}, ${`LIVE-RX-${auctionId}`}, 'reverse',
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         now(), 'published', true, false, 0, false, false, now(), ${createdBy})
    `);

    const uom = (
      await tx.execute<{ id: number }>(sql`
        SELECT id FROM uoms WHERE upper(replace(code, ' ', '')) IN ('MT','RSPMT','AEDPMT')
        ORDER BY id LIMIT 1
      `)
    ).rows[0];

    const lotIds: number[] = [];
    for (let i = 1; i <= lots; i++) {
      await tx.execute(sql`
        INSERT INTO auction_lots
          (id, client_id, auction_id, lot_number, quantity, start_bid_price, uom_id,
           bid_increment, bid_limit, display_order, start_time, end_time, status, is_approved,
           is_active, is_no_bid_extension, created_at, created_by)
        VALUES
          (${lotId}, ${clientId}, ${auctionId}, ${`Lot ${i}`}, 100, ${startBidPrice},
           ${uom?.id ?? null}, ${bidIncrement}, ${bidLimit}, ${i},
           ((now() AT TIME ZONE 'Asia/Kolkata') - make_interval(mins => ${leadMin}))::time,
           ((now() AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => ${durationMin}))::time,
           1, true, true, false, now(), ${createdBy})
      `);
      lotIds.push(lotId);
      lotId++;
    }

    for (const b of bidderRows) {
      await tx.execute(sql`
        INSERT INTO auction_lot_bidder_maps
          (id, auction_id, client_id, bidder_id, lot_id, is_emd_with_client,
           is_active, created_at, created_by)
        VALUES
          (${mapId}, ${auctionId}, ${clientId}, ${b.bidder_id}, NULL, false,
           true, now(), ${createdBy})
      `);
      mapId++;
    }

    // Reverse proxies: lower min is more aggressive. A min 500 vs B min 700
    // → A wins at 600 (B.min − increment). Keep mins above the lot floor.
    const proxyMaxA = num(
      process.env.PROXY_MAX_A,
      Math.max(bidLimit + bidIncrement, startBidPrice - 5 * bidIncrement),
    );
    const proxyMaxB = num(
      process.env.PROXY_MAX_B,
      Math.max(bidLimit + 2 * bidIncrement, startBidPrice - 3 * bidIncrement),
    );

    const seededProxies: {
      bidderId: number;
      userId: number;
      max: number;
    }[] = [];

    if (seedProxies) {
      const a = bidderRows[0]!;
      const b = bidderRows[1]!;
      // Lower max first so row ids encode submission order (A then B).
      // Settlement: A max > B max → A wins at B.max + increment.
      for (const [bidder, max] of [
        [a, proxyMaxA],
        [b, proxyMaxB],
      ] as const) {
        await tx.execute(sql`
          INSERT INTO auction_proxy_bids
            (auction_id, lot_id, bidder_id, user_id, max_amount, is_active, created_at)
          VALUES
            (${auctionId}, ${firstLotId}, ${bidder.bidder_id}, ${bidder.user_id},
             ${max.toFixed(2)}, true, now())
        `);
        seededProxies.push({
          bidderId: bidder.bidder_id,
          userId: bidder.user_id,
          max,
        });
      }
    }

    const times = (
      await tx.execute<{ starts: string; ends: string }>(sql`
        SELECT
          to_char((now() AT TIME ZONE 'Asia/Kolkata') - make_interval(mins => ${leadMin}), 'HH24:MI:SS') AS starts,
          to_char((now() AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => ${durationMin}), 'HH24:MI:SS') AS ends
      `)
    ).rows[0]!;

    return {
      auctionId,
      auctionNumber: `LIVE-RX-${auctionId}`,
      client: { id: clientId, name: clientRow.company_name },
      lots,
      lotIds,
      firstLotId,
      startBidPrice,
      bidLimit,
      bidIncrement,
      startsIst: times.starts,
      endsIst: times.ends,
      bidders: bidderRows,
      seededProxies,
      seedProxies,
      proxyMaxA,
      proxyMaxB,
    };
  });

  console.log("\n✅ Live REVERSE proxy auction created\n");
  console.log(`  Auction    #${summary.auctionId}  (${summary.auctionNumber})`);
  console.log(`  Client     #${summary.client.id}  ${summary.client.name}`);
  console.log(
    `  Lots       ${summary.lots}  ·  open ${summary.startsIst} → ${summary.endsIst} IST`,
  );
  console.log(
    `  Lot ids    ${summary.lotIds.join(", ")}  (lot 1 = ${summary.firstLotId})`,
  );
  console.log(
    `  Pricing    SBP ${summary.startBidPrice}  ·  floor ${summary.bidLimit}  ·  decrement ${summary.bidIncrement}`,
  );
  console.log(`\n  Mapped ${summary.bidders.length} bidder(s):`);
  for (const b of summary.bidders) {
    console.log(
      `    bidder #${b.bidder_id}  user #${b.user_id}  login "${b.login}"  (${b.company_name})`,
    );
  }

  if (summary.seedProxies && summary.seededProxies.length > 0) {
    console.log(`\n  Seeded standing proxies on lot #${summary.firstLotId}:`);
    for (const p of summary.seededProxies) {
      console.log(`    bidder #${p.bidderId}  min ${p.max}`);
    }
  } else {
    console.log(`\n  No proxies seeded (SEED_PROXIES not set).`);
    console.log(`  To seed standing mins on lot 1 next time:`);
    console.log(
      `    SEED_PROXIES=1 PROXY_MAX_A=${summary.proxyMaxA} PROXY_MAX_B=${summary.proxyMaxB} pnpm seed:live-reverse-proxy-auction`,
    );
  }

  const bidderIds = summary.bidders.map((b) => b.bidder_id).join(",");
  const userIds = summary.bidders.map((b) => b.user_id).join(",");
  console.log(`\n  Load harness example (descending amounts):`);
  console.log(
    `    AUCTION_ID=${summary.auctionId} LOT_ID=${summary.firstLotId} \\`,
  );
  console.log(`    BIDDER_IDS=${bidderIds} USER_IDS=${userIds} \\`);
  console.log(`    DIRECTION=reverse pnpm --filter @auctionit/api live:load-harness\n`);

  process.exit(0);
}

main().catch((e) => {
  console.error("Failed to seed live reverse proxy auction:", e);
  process.exit(1);
});

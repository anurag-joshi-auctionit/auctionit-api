import { sql } from "drizzle-orm";
import { db } from "../index.js";

/**
 * Create ONE live auction (published, dated today IST, lots open right now) in a
 * single transaction — for testing the live monitor / live bidding / anti-snipe.
 *
 * Run: pnpm --filter @auctionit/api seed:live-auction
 *
 * Optional env overrides:
 *   CLIENT_ID      client to attach the auction to (default: first active client)
 *   LOTS           number of lots to create           (default: 3)
 *   LEAD_MIN       minutes ago the lots opened         (default: 5)
 *   DURATION_MIN   minutes from now the lots close     (default: 30)
 *   BIDDER_IDS     comma-separated bidder ids to map   (default: bidders that
 *                  have a login user, capped by BIDDER_LIMIT)
 *   BIDDER_LIMIT   cap for the default bidder set      (default: 25)
 *
 * All primary keys are manual integers in this schema, so ids are allocated as
 * MAX(id)+1 per table inside the transaction.
 */

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

async function main() {
  const lots = num(process.env.LOTS, 3);
  const leadMin = num(process.env.LEAD_MIN, 5);
  const durationMin = num(process.env.DURATION_MIN, 30);
  const bidderLimit = num(process.env.BIDDER_LIMIT, 25);
  const clientIdOverride = process.env.CLIENT_ID
    ? num(process.env.CLIENT_ID, 0)
    : null;
  const bidderIdsOverride = process.env.BIDDER_IDS
    ? process.env.BIDDER_IDS.split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : null;

  const summary = await db.transaction(async (tx) => {
    // ---- Pick the client -----------------------------------------------------
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

    // A staff user to own the audit columns (created_by / updated_by → users.id).
    const staff = (
      await tx.execute<{ id: number }>(sql`
        SELECT id FROM users WHERE bidder_id IS NULL AND is_active = true
        ORDER BY id LIMIT 1
      `)
    ).rows[0];
    if (!staff) throw new Error("No staff user found for created_by.");
    const createdBy = staff.id;

    // ---- Resolve the bidders to map -----------------------------------------
    // Only bidders that have a login user can actually sign in and bid.
    const bidderRows = (
      await tx.execute<{
        bidder_id: number;
        company_name: string;
        login: string;
      }>(
        bidderIdsOverride
          ? sql`
              SELECT b.id AS bidder_id, b.company_name, u.user_login_name AS login
              FROM bidders b
              JOIN users u ON u.bidder_id = b.id AND u.is_active = true
              WHERE b.id IN (${sql.join(
                bidderIdsOverride.map((id) => sql`${id}`),
                sql`, `,
              )})
              ORDER BY b.id
            `
          : sql`
              SELECT b.id AS bidder_id, b.company_name, u.user_login_name AS login
              FROM bidders b
              JOIN users u ON u.bidder_id = b.id AND u.is_active = true
              WHERE b.is_active = true
              ORDER BY b.id DESC
              LIMIT ${bidderLimit}
            `,
      )
    ).rows;
    if (bidderRows.length === 0) {
      throw new Error(
        "No mappable bidders (need bidders with an active login user).",
      );
    }

    // ---- Allocate ids (manual PKs) ------------------------------------------
    // These tables use manual integer PKs and are actively bulk-loaded from
    // MSSQL (ids up to ~55M). MAX(id)+1 races that loader (its uncommitted rows
    // are invisible here, so we'd pick an id it's about to claim). Instead carve
    // ids from a reserved band well above any legacy id and under the int4 max —
    // untouched by the loader and collision-free across repeated runs. It also
    // makes seeded test rows easy to spot and clean up.
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

    // ---- Insert the auction: published, today (IST), forward ----------------
    await tx.execute(sql`
      INSERT INTO auctions
        (auction_id, client_id, auction_number, auction_type, auction_date,
         published_at, status, is_active, is_no_bid_extension, no_bid_extension_count_max,
         is_start_bid_price_plus_increment, is_rank_based, created_at, created_by)
      VALUES
        (${auctionId}, ${clientId}, ${`LIVE-${auctionId}`}, 'forward',
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         now(), 'published', true, false, 0, false, false, now(), ${createdBy})
    `);

    // A UOM in the live-monitor "quantity" set, so Offered/Sold Qty populate.
    const uom = (
      await tx.execute<{ id: number }>(sql`
        SELECT id FROM uoms WHERE upper(replace(code, ' ', '')) IN ('MT','RSPMT','AEDPMT')
        ORDER BY id LIMIT 1
      `)
    ).rows[0];

    // ---- Insert lots that are open right now (IST) --------------------------
    for (let i = 1; i <= lots; i++) {
      await tx.execute(sql`
        INSERT INTO auction_lots
          (id, client_id, auction_id, lot_number, quantity, start_bid_price, uom_id,
           bid_increment, display_order, start_time, end_time, status, is_approved,
           is_active, is_no_bid_extension, created_at, created_by)
        VALUES
          (${lotId}, ${clientId}, ${auctionId}, ${`Lot ${i}`}, 100, 1000,
           ${uom?.id ?? null}, 100, ${i},
           ((now() AT TIME ZONE 'Asia/Kolkata') - make_interval(mins => ${leadMin}))::time,
           ((now() AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => ${durationMin}))::time,
           1, true, true, false, now(), ${createdBy})
      `);
      lotId++;
    }

    // ---- Map bidders auction-wide (lot_id NULL) so they can bid any lot -----
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

    // Client live-bid settings (for context — these drive extend/staggering).
    const settings = (
      await tx.execute(sql`
        SELECT is_last_bid_extension, last_bid_extension_window, last_bid_extension_interval, last_bid_extension_count_max,
               is_staggered, stagger_interval
        FROM clients WHERE id = ${clientId}
      `)
    ).rows[0];

    const times = (
      await tx.execute<{ starts: string; ends: string }>(sql`
        SELECT
          to_char((now() AT TIME ZONE 'Asia/Kolkata') - make_interval(mins => ${leadMin}), 'HH24:MI:SS') AS starts,
          to_char((now() AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => ${durationMin}), 'HH24:MI:SS') AS ends
      `)
    ).rows[0]!;

    return {
      auctionId,
      auctionNumber: `LIVE-${auctionId}`,
      client: { id: clientId, name: clientRow.company_name },
      lots,
      startsIst: times.starts,
      endsIst: times.ends,
      bidders: bidderRows,
      settings,
    };
  });

  console.log("\n✅ Live auction created\n");
  console.log(`  Auction    #${summary.auctionId}  (${summary.auctionNumber})`);
  console.log(`  Client     #${summary.client.id}  ${summary.client.name}`);
  console.log(
    `  Lots       ${summary.lots}  ·  open ${summary.startsIst} → ${summary.endsIst} IST (today)`,
  );
  console.log(`  Client live-bid settings:`, summary.settings);
  console.log(
    `\n  Mapped ${summary.bidders.length} bidder(s) — log in as one of these to bid:`,
  );
  for (const b of summary.bidders.slice(0, 10)) {
    console.log(
      `    bidder #${b.bidder_id}  login "${b.login}"  (${b.company_name})`,
    );
  }
  if (summary.bidders.length > 10) {
    console.log(`    …and ${summary.bidders.length - 10} more`);
  }
  console.log(
    `\n  Admin live monitor: open /auctions → Live card, or the live monitor page.\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("Failed to seed live auction:", e);
  process.exit(1);
});

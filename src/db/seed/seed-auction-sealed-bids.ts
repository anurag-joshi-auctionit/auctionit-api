import pg from "pg";
import { env } from "../../env.js";
import { connectMssql } from "./mssql.js";

/**
 * Seed auction_sealed_bids from legacy Online Sealed Bid (OSB) desired prices.
 *
 * Source: tbl_Data_OnlineSealedBid → auction_sealed_bids
 *   AuctionId → auction_id, LotID → lot_id, ClientId → client_id,
 *   BidderCompId → bidder_id, BidderUserId → user_id,
 *   DesiredAmount → amount, CreateDatetime → created_at  (no IP → ip null)
 *
 * Legacy OSB allowed one desired price per lot per bidder; the new ledger is
 * append-only (latest row per bidder wins), so each legacy row maps 1:1.
 * Rows whose auction / lot / bidder are missing in Postgres are skipped.
 * Soft-dedupe on (lot_id, bidder_id, amount, created_at) when not SEED_RESET.
 * Run AFTER seed:auctions, seed:auction-lots, seed:bidders, seed:users.
 * Set SEED_RESET=1 to TRUNCATE auction_sealed_bids before reload.
 */

const SOURCE_SQL = `
SELECT
  ID AS id,
  AuctionId AS auctionId,
  LotID AS lotId,
  ClientId AS clientId,
  BidderCompId AS bidderId,
  COALESCE(BidderUserId, CreatedBy) AS userId,
  DesiredAmount AS amount,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt
FROM tbl_Data_OnlineSealedBid
ORDER BY ID
`;

const PG_INSERT_CHUNK = 2_000;

type SourceRow = {
  id: number;
  auctionId: number | null;
  lotId: number | null;
  clientId: number | null;
  bidderId: number | null;
  userId: number | null;
  amount: string | number | null;
  createdAt: string | null;
};

type PreparedSealedBid = {
  auctionId: number;
  lotId: number;
  clientId: number | null;
  bidderId: number;
  userId: number | null;
  amount: string;
  createdAt: string;
};

// Auction / client fall back to the lot's own when the legacy value is missing
// or points at a row Postgres doesn't have. user_id is nullable — dropped to
// NULL when the legacy user isn't in Postgres rather than skipping the bid.
const INSERT_SQL = (dedupe: boolean) => `
INSERT INTO auction_sealed_bids (
  auction_id, lot_id, client_id, bidder_id, user_id, amount, ip, created_at
)
SELECT
  al.auction_id,
  v.lot_id,
  COALESCE(
    (SELECT c.id FROM clients c WHERE c.id = v.client_id),
    a.client_id
  ),
  v.bidder_id,
  (SELECT u.id FROM users u WHERE u.id = v.user_id),
  v.amount,
  NULL,
  v.created_at
FROM UNNEST(
  $1::int[],
  $2::int[],
  $3::int[],
  $4::int[],
  $5::int[],
  $6::numeric[],
  $7::timestamptz[]
) AS v(auction_id, lot_id, client_id, bidder_id, user_id, amount, created_at)
JOIN auction_lots al ON al.id = v.lot_id
JOIN auctions a ON a.auction_id = al.auction_id
JOIN bidders b ON b.id = v.bidder_id
${
  dedupe
    ? `WHERE NOT EXISTS (
  SELECT 1 FROM auction_sealed_bids sb
  WHERE sb.lot_id = v.lot_id
    AND sb.bidder_id = v.bidder_id
    AND sb.amount = v.amount
    AND sb.created_at = v.created_at
)`
    : ""
}
`;

function asInt(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asAmount(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

function prepareRow(r: SourceRow): PreparedSealedBid | null {
  const lotId = asInt(r.lotId);
  const bidderId = asInt(r.bidderId);
  const amount = asAmount(r.amount);
  if (lotId == null || bidderId == null || amount == null || !r.createdAt) {
    return null;
  }
  return {
    auctionId: asInt(r.auctionId) ?? 0,
    lotId,
    clientId: asInt(r.clientId),
    bidderId,
    userId: asInt(r.userId),
    amount,
    createdAt: r.createdAt,
  };
}

async function main() {
  const started = Date.now();
  const resetMode = process.env.SEED_RESET === "1";
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    const rows = result.recordset;
    console.log(`Pulled ${rows.length} OnlineSealedBid rows from MSSQL.`);
    if (rows.length === 0) {
      console.log("Nothing to seed.");
      console.log("SEED_OUTCOME ok skipped=0");
      return;
    }

    const prepared: PreparedSealedBid[] = [];
    let invalid = 0;
    for (const r of rows) {
      const row = prepareRow(r);
      if (row == null) invalid++;
      else prepared.push(row);
    }

    const client = await pgPool.connect();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      if (resetMode) {
        console.log("SEED_RESET=1 — truncating auction_sealed_bids…");
        await client.query(
          "TRUNCATE TABLE auction_sealed_bids RESTART IDENTITY",
        );
      }
      for (let i = 0; i < prepared.length; i += PG_INSERT_CHUNK) {
        const chunk = prepared.slice(i, i + PG_INSERT_CHUNK);
        const res = await client.query(INSERT_SQL(!resetMode), [
          chunk.map((r) => r.auctionId),
          chunk.map((r) => r.lotId),
          chunk.map((r) => r.clientId),
          chunk.map((r) => r.bidderId),
          chunk.map((r) => r.userId),
          chunk.map((r) => r.amount),
          chunk.map((r) => r.createdAt),
        ]);
        inserted += res.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Rows that failed FK joins (lot/bidder missing), invalid fields, or soft-dedupe.
    const skipped = rows.length - inserted;
    console.log(
      `Inserted ${inserted} auction_sealed_bids (${skipped} skipped, ` +
        `${invalid} invalid fields) in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
    );
    console.log(
      skipped > 0
        ? `SEED_OUTCOME warn inserted=${inserted} skipped=${skipped}`
        : `SEED_OUTCOME ok inserted=${inserted} skipped=0`,
    );
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

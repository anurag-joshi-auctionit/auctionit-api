import pg from "pg";
import { env } from "../../env.js";
import {
  countMssqlRows,
  fetchMssqlBatches,
  resolveSeedBatchSize,
} from "./batch-mssql.js";
import { connectMssql } from "./mssql.js";

/**
 * Seed auction_bid_logs attempt audit from legacy transaction log.
 *
 * Source: tbl_Data_AuctionTransaction_Log → auction_bid_logs
 *   AuctionId → auction_id, LotID → lot_id, BidderCompId → bidder_id,
 *   BidderUserId → user_id, BidAmount → amount,
 *   IsProxyBid → is_proxy, ProxyBidAmount → proxy_amount,
 *   IPAddress → ip, CreateDatetime → created_at
 *
 * Always: is_accepted=NULL, reject_reason=NULL (legacy log has no status).
 *
 * auction_bid_logs.id is generatedAlwaysAsIdentity — legacy IDs are not preserved.
 * Soft-dedupe on (lot_id, bidder_id, amount, created_at, ip) when not SEED_RESET.
 * Run AFTER seed:auction-lots, seed:bidders, seed:users (same as auction_bids).
 * Set SEED_RESET=1 to TRUNCATE auction_bid_logs before reload.
 * Default page size is {@link resolveSeedBatchSize} (100k; override with SEED_BATCH_SIZE).
 */

const SOURCE_FROM = "tbl_Data_AuctionTransaction_Log";
const SOURCE_ID_COLUMN = "ID";
const SOURCE_SELECT_LIST = `
  ID AS id,
  AuctionId AS auctionId,
  LotID AS lotId,
  BidderCompId AS bidderId,
  BidderUserId AS userId,
  BidAmount AS amount,
  IsProxyBid AS isProxy,
  ProxyBidAmount AS proxyAmount,
  IPAddress AS ip,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt
`;

/** Chunk size for UNNEST inserts (keeps query params manageable). */
const PG_INSERT_CHUNK = 2_000;

type SourceRow = {
  id: number;
  auctionId: number | null;
  lotId: number | null;
  bidderId: number | null;
  userId: number | null;
  amount: string | number | null;
  isProxy: boolean | number | null;
  proxyAmount: string | number | null;
  ip: string | null;
  createdAt: string | null;
};

type PreparedLog = {
  auctionId: number | null;
  lotId: number;
  bidderId: number;
  userId: number;
  amount: string;
  isProxy: boolean;
  proxyAmount: string | null;
  ip: string | null;
  createdAt: string;
};

const INSERT_WITH_DEDUPE_SQL = `
INSERT INTO auction_bid_logs (
  auction_id, lot_id, bidder_id, user_id, amount,
  is_proxy, proxy_amount, ip, is_accepted, reject_reason, created_at
)
SELECT
  COALESCE(
    (SELECT a.auction_id FROM auctions a WHERE a.auction_id = v.auction_id),
    al.auction_id
  ),
  v.lot_id,
  v.bidder_id,
  v.user_id,
  v.amount,
  v.is_proxy,
  v.proxy_amount,
  v.ip,
  NULL,
  NULL,
  v.created_at
FROM UNNEST(
  $1::int[],
  $2::int[],
  $3::int[],
  $4::int[],
  $5::numeric[],
  $6::boolean[],
  $7::numeric[],
  $8::varchar[],
  $9::timestamptz[]
) AS v(
  auction_id, lot_id, bidder_id, user_id,
  amount, is_proxy, proxy_amount, ip, created_at
)
JOIN auction_lots al ON al.id = v.lot_id
JOIN bidders b ON b.id = v.bidder_id
JOIN users u ON u.id = v.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM auction_bid_logs abl
  WHERE abl.lot_id = v.lot_id
    AND abl.bidder_id = v.bidder_id
    AND abl.amount = v.amount
    AND abl.created_at = v.created_at
    AND abl.ip IS NOT DISTINCT FROM v.ip
)
`;

const INSERT_FAST_SQL = `
INSERT INTO auction_bid_logs (
  auction_id, lot_id, bidder_id, user_id, amount,
  is_proxy, proxy_amount, ip, is_accepted, reject_reason, created_at
)
SELECT
  COALESCE(
    (SELECT a.auction_id FROM auctions a WHERE a.auction_id = v.auction_id),
    al.auction_id
  ),
  v.lot_id,
  v.bidder_id,
  v.user_id,
  v.amount,
  v.is_proxy,
  v.proxy_amount,
  v.ip,
  NULL,
  NULL,
  v.created_at
FROM UNNEST(
  $1::int[],
  $2::int[],
  $3::int[],
  $4::int[],
  $5::numeric[],
  $6::boolean[],
  $7::numeric[],
  $8::varchar[],
  $9::timestamptz[]
) AS v(
  auction_id, lot_id, bidder_id, user_id,
  amount, is_proxy, proxy_amount, ip, created_at
)
JOIN auction_lots al ON al.id = v.lot_id
JOIN bidders b ON b.id = v.bidder_id
JOIN users u ON u.id = v.user_id
`;

function asBool(v: boolean | number | null | undefined): boolean {
  return v === true || v === 1;
}

function asAmount(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

function asIp(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > 64 ? s.slice(0, 64) : s;
}

function prepareRow(r: SourceRow): PreparedLog | null {
  const lotId = r.lotId != null ? Number(r.lotId) : null;
  const bidderId = r.bidderId != null ? Number(r.bidderId) : null;
  const userId = r.userId != null ? Number(r.userId) : null;
  const amount = asAmount(r.amount);
  const createdAt = r.createdAt;
  if (
    lotId == null ||
    !Number.isFinite(lotId) ||
    bidderId == null ||
    !Number.isFinite(bidderId) ||
    userId == null ||
    !Number.isFinite(userId) ||
    amount == null ||
    !createdAt
  ) {
    return null;
  }
  const isProxy = asBool(r.isProxy);
  return {
    auctionId:
      r.auctionId != null && Number.isFinite(Number(r.auctionId))
        ? Number(r.auctionId)
        : null,
    lotId,
    bidderId,
    userId,
    amount,
    isProxy,
    proxyAmount: isProxy ? asAmount(r.proxyAmount) : null,
    ip: asIp(r.ip),
    createdAt,
  };
}

async function insertChunk(
  client: pg.PoolClient,
  rows: PreparedLog[],
  resetMode: boolean,
): Promise<number> {
  if (rows.length === 0) return 0;
  const auctionIds = rows.map((r) => r.auctionId);
  const lotIds = rows.map((r) => r.lotId);
  const bidderIds = rows.map((r) => r.bidderId);
  const userIds = rows.map((r) => r.userId);
  const amounts = rows.map((r) => r.amount);
  const isProxies = rows.map((r) => r.isProxy);
  const proxyAmounts = rows.map((r) => r.proxyAmount);
  const ips = rows.map((r) => r.ip);
  const createdAts = rows.map((r) => r.createdAt);

  const result = await client.query(
    resetMode ? INSERT_FAST_SQL : INSERT_WITH_DEDUPE_SQL,
    [
      auctionIds,
      lotIds,
      bidderIds,
      userIds,
      amounts,
      isProxies,
      proxyAmounts,
      ips,
      createdAts,
    ],
  );
  return result.rowCount ?? 0;
}

async function main() {
  const started = Date.now();
  const batchSize = resolveSeedBatchSize();
  const resetMode = process.env.SEED_RESET === "1";
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    if (resetMode) {
      console.log("SEED_RESET=1 — truncating auction_bid_logs…");
      await pgPool.query("TRUNCATE TABLE auction_bid_logs RESTART IDENTITY");
    }

    console.log("Counting MSSQL AuctionTransaction_Log rows…");
    const totalSource = await countMssqlRows(mssqlPool, SOURCE_FROM);
    const totalBatches = Math.max(1, Math.ceil(totalSource / batchSize));
    console.log(
      `Source has ${totalSource} AuctionTransaction_Log rows; batching ${batchSize}/page (~${totalBatches} batches).` +
        (resetMode ? " Soft-dedupe off (fresh truncate)." : " Soft-dedupe on."),
    );

    if (totalSource === 0) {
      console.log("Nothing to seed.");
      console.log("SEED_OUTCOME ok skipped=0");
      return;
    }

    let inserted = 0;
    let skipped = 0;
    let nextBatch = 1;

    console.log(
      `Fetching MSSQL batch ${nextBatch}/${totalBatches} (keyset, up to ${batchSize} rows)…`,
    );
    let fetchStarted = Date.now();

    for await (const page of fetchMssqlBatches<SourceRow>(mssqlPool, {
      selectList: SOURCE_SELECT_LIST,
      fromClause: SOURCE_FROM,
      idColumn: SOURCE_ID_COLUMN,
      getRowId: (r) => Number(r.id),
      batchSize,
    })) {
      const fetchSec = ((Date.now() - fetchStarted) / 1000).toFixed(1);
      console.log(
        `Fetched batch ${page.batchIndex}/${totalBatches}: ${page.rows.length} rows ` +
          `(lastId=${page.lastId}) in ${fetchSec}s; inserting…`,
      );

      const prepared: PreparedLog[] = [];
      let invalid = 0;
      for (const r of page.rows) {
        const row = prepareRow(r);
        if (row == null) {
          invalid++;
          continue;
        }
        prepared.push(row);
      }

      const insertStarted = Date.now();
      const client = await pgPool.connect();
      let batchInserted = 0;
      try {
        await client.query("BEGIN");
        for (let i = 0; i < prepared.length; i += PG_INSERT_CHUNK) {
          const chunk = prepared.slice(i, i + PG_INSERT_CHUNK);
          batchInserted += await insertChunk(client, chunk, resetMode);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      // Rows that failed FK joins (lot/bidder/user missing) or soft-dedupe.
      const batchSkipped = page.rows.length - batchInserted;
      inserted += batchInserted;
      skipped += batchSkipped;
      const insertSec = ((Date.now() - insertStarted) / 1000).toFixed(1);
      console.log(
        `Batch ${page.batchIndex}/${totalBatches}: inserted ${batchInserted}, ` +
          `skipped ${batchSkipped} (${invalid} invalid fields) ` +
          `[insert ${insertSec}s, elapsed ${((Date.now() - started) / 1000).toFixed(1)}s].`,
      );

      nextBatch = page.batchIndex + 1;
      if (page.rows.length >= batchSize) {
        console.log(
          `Fetching MSSQL batch ${nextBatch}/${totalBatches} (keyset, up to ${batchSize} rows)…`,
        );
        fetchStarted = Date.now();
      }
    }

    console.log(
      `Inserted ${inserted} auction_bid_logs (${skipped} skipped) in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
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

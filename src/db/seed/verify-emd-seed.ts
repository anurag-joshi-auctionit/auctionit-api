import pg from "pg";
import { env } from "../../env.js";
import { round2, toAmount } from "../../lib/emd/constants.js";
import { connectMssql } from "./mssql.js";

/**
 * Reconciles the seeded EMD ledger against MSSQL (run after `pnpm seed:emd`).
 * Fails (exit 1) when:
 *   - a bidder's Available differs from the legacy passbook net (CR - DR);
 *   - an (auction, bidder) Blocked + Winning differs from the legacy net DR - CR
 *     on that auction (forfeited money stays in Winning, as in legacy);
 *   - open refund count / amount differ from open PayEMD rows;
 *   - the bidders balance caches differ from the ledger.
 * Legacy bidder master EMD vs passbook drift, refund/transfer link coverage,
 * deposits without a payment mode and skipped forfeitures are printed for
 * information only.
 */

const LEGACY_BIDDER_NET_SQL = `
SELECT BidderCompId AS bidderId,
       CONVERT(varchar(40), SUM(ISNULL(AmountCR, 0) - ISNULL(AmountDR, 0))) AS net
FROM tbl_Data_BidderPassBook
WHERE ISNULL(BidderCompId, 0) <> 0
GROUP BY BidderCompId`;

const LEGACY_PAIR_NET_SQL = `
SELECT AuctionId AS auctionId, BidderCompId AS bidderId,
       CONVERT(varchar(40), SUM(ISNULL(AmountDR, 0) - ISNULL(AmountCR, 0))) AS net
FROM tbl_Data_BidderPassBook
WHERE ISNULL(BidderCompId, 0) <> 0 AND ISNULL(AuctionId, 0) <> 0
GROUP BY AuctionId, BidderCompId`;

const LEGACY_OPEN_REFUNDS_SQL = `
SELECT BidderCompId AS bidderId, CONVERT(varchar(40), Amount) AS amount
FROM tbl_Data_PayEMD
WHERE PayStatus = 1 AND LTRIM(ISNULL(TransactionId, '')) = '' AND ISNULL(AccountStatus, 0) <> 3 AND Amount > 0`;

const LEGACY_MASTER_SQL = `
SELECT BidderCompId AS bidderId, CONVERT(varchar(40), ISNULL(EMD, 0)) AS emd
FROM tbl_Config_BidderCompanyMst`;

const SEEDED_BIDDER_SQL = `
SELECT bidder_id,
       SUM(CASE WHEN txn_type = 'credit' THEN amount ELSE -amount END)::text AS available
FROM emd_transactions GROUP BY bidder_id`;

const SEEDED_PAIR_SQL = `
SELECT auction_id, bidder_id,
       SUM(CASE
             WHEN emd_type IN ('blocked_bidder_attached', 'blocked_winning') THEN amount
             WHEN emd_type IN ('release_auction_closed', 'release_bidder_detached',
                               'release_lot_withdrawn', 'release_bidder_unverified', 'release_by_admin',
                               'release_lot_rejected', 'release_block_revised', 'release_winning_by_admin') THEN -amount
             ELSE 0
           END)::text AS held
FROM emd_transactions WHERE auction_id IS NOT NULL
GROUP BY auction_id, bidder_id`;

const SEEDED_OPEN_REFUNDS_SQL = `
SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::text AS amount FROM emd_refunds
WHERE status IN ('requested', 'reviewed', 'verified')`;

const LEGACY_FORFEITED_SQL = `
SELECT id, AuctionId AS auctionId, BidderCompId AS bidderId, CONVERT(varchar(40), Amount) AS amount
FROM tbl_Data_EMDForFeited`;

const REFUND_LINK_SQL = `
SELECT r.status, COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM emd_transactions t WHERE t.refund_id = r.id
           AND t.emd_type IN ('refund_requested', 'refund_processed')))::int AS linked
FROM emd_refunds r GROUP BY r.status ORDER BY r.status`;

const LINK_COUNTS_SQL = `
SELECT (SELECT COUNT(*) FROM emd_transfers)::int AS transfers,
       (SELECT COUNT(*) FROM emd_transactions
         WHERE emd_type IN ('transfer_in', 'transfer_out') AND transfer_id IS NULL)::int AS transfer_rows_unlinked,
       (SELECT COUNT(*) FROM emd_transactions
         WHERE emd_type = 'refund_cancelled' AND refund_id IS NULL)::int AS cancel_credits_unlinked,
       (SELECT COUNT(*) FROM emd_transactions
         WHERE emd_type = 'emd_deposit' AND payment_type_id IS NULL)::int AS deposits_untyped,
       (SELECT COUNT(*) FROM emd_transactions
         WHERE emd_type = 'emd_deposit' AND payment_type_id IS NULL AND txn_ref_no IS NOT NULL)::int AS deposits_untyped_with_utr`;

const CACHE_DRIFT_SQL = `
WITH l AS (
  SELECT bidder_id, SUM(CASE WHEN txn_type = 'credit' THEN amount ELSE -amount END) AS available
  FROM emd_transactions GROUP BY bidder_id
)
SELECT b.id, b.emd_available_balance::text AS cached, COALESCE(l.available, 0)::text AS ledger
FROM bidders b LEFT JOIN l ON l.bidder_id = b.id
WHERE b.emd_available_balance IS DISTINCT FROM COALESCE(l.available, 0)
LIMIT 20`;

function key(...parts: (string | number)[]) {
  return parts.join(":");
}

async function main() {
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });
  let failures = 0;
  const fail = (msg: string) => {
    failures++;
    console.log(`  FAIL ${msg}`);
  };

  try {
    const [legacyBidders, legacyPairs, legacyRefunds, legacyMaster, legacyForfeited] = await Promise.all([
      mssqlPool.request().query<{ bidderId: number; net: string }>(LEGACY_BIDDER_NET_SQL),
      mssqlPool.request().query<{ auctionId: number; bidderId: number; net: string }>(LEGACY_PAIR_NET_SQL),
      mssqlPool.request().query<{ bidderId: number; amount: string }>(LEGACY_OPEN_REFUNDS_SQL),
      mssqlPool.request().query<{ bidderId: number; emd: string }>(LEGACY_MASTER_SQL),
      mssqlPool
        .request()
        .query<{ id: number; auctionId: number; bidderId: number; amount: string }>(LEGACY_FORFEITED_SQL),
    ]);
    const [bidderIds, auctionIds, seededBidders, seededPairs, seededRefunds, cacheDrift] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM bidders"),
      pgPool.query<{ id: number }>("SELECT auction_id AS id FROM auctions"),
      pgPool.query<{ bidder_id: number; available: string }>(SEEDED_BIDDER_SQL),
      pgPool.query<{ auction_id: number; bidder_id: number; held: string }>(SEEDED_PAIR_SQL),
      pgPool.query<{ n: number; amount: string }>(SEEDED_OPEN_REFUNDS_SQL),
      pgPool.query<{ id: number; cached: string; ledger: string }>(CACHE_DRIFT_SQL),
    ]);
    const bidderSet = new Set(bidderIds.rows.map((r) => r.id));
    const auctionSet = new Set(auctionIds.rows.map((r) => r.id));

    console.log("Available per bidder (ledger vs legacy passbook net)");
    const seededAvail = new Map(seededBidders.rows.map((r) => [r.bidder_id, round2(toAmount(r.available))]));
    let bidderDiffs = 0;
    for (const r of legacyBidders.recordset) {
      const id = Number(r.bidderId);
      if (!bidderSet.has(id)) continue;
      const want = round2(toAmount(r.net));
      const got = seededAvail.get(id) ?? 0;
      if (want !== got) {
        bidderDiffs++;
        if (bidderDiffs <= 20) fail(`bidder ${id}: legacy ${want}, seeded ${got}`);
      }
    }
    if (bidderDiffs > 20) fail(`... ${bidderDiffs - 20} more bidder differences`);
    console.log(`  checked ${legacyBidders.recordset.length} bidders, ${bidderDiffs} differences`);

    console.log("Blocked + Winning per (auction, bidder) vs legacy net on auction");
    const seededHeld = new Map(
      seededPairs.rows.map((r) => [key(r.auction_id, r.bidder_id), round2(toAmount(r.held))]),
    );
    let pairDiffs = 0;
    let pairsChecked = 0;
    for (const r of legacyPairs.recordset) {
      const auctionId = Number(r.auctionId);
      const bidderId = Number(r.bidderId);
      if (!bidderSet.has(bidderId) || !auctionSet.has(auctionId)) continue;
      pairsChecked++;
      const want = round2(toAmount(r.net));
      const got = seededHeld.get(key(auctionId, bidderId)) ?? 0;
      if (want !== got) {
        pairDiffs++;
        if (pairDiffs <= 20) fail(`auction ${auctionId} bidder ${bidderId}: legacy ${want}, seeded ${got}`);
      }
    }
    if (pairDiffs > 20) fail(`... ${pairDiffs - 20} more pair differences`);
    console.log(`  checked ${pairsChecked} pairs, ${pairDiffs} differences`);

    console.log("Open refunds");
    const openLegacy = legacyRefunds.recordset.filter((r) => bidderSet.has(Number(r.bidderId)));
    const lrCount = openLegacy.length;
    const lrAmount = round2(openLegacy.reduce((sum, r) => sum + toAmount(r.amount), 0));
    const sr = seededRefunds.rows[0]!;
    const srAmount = round2(toAmount(sr.amount));
    console.log(`  legacy ${lrCount} (${lrAmount}), seeded ${sr.n} (${srAmount})`);
    if (lrCount !== Number(sr.n) || lrAmount !== srAmount) fail("open refund totals differ");

    console.log("Balance caches");
    for (const r of cacheDrift.rows) fail(`bidder ${r.id}: cached ${r.cached}, ledger ${r.ledger}`);
    console.log(`  ${cacheDrift.rows.length === 0 ? "in sync" : "drift found"}`);

    console.log("Legacy master EMD vs passbook (information only)");
    const legacyNet = new Map(legacyBidders.recordset.map((r) => [Number(r.bidderId), round2(toAmount(r.net))]));
    let masterDrift = 0;
    for (const r of legacyMaster.recordset) {
      const id = Number(r.bidderId);
      if (round2(toAmount(r.emd)) !== (legacyNet.get(id) ?? 0)) masterDrift++;
    }
    console.log(`  ${masterDrift} bidders where legacy master EMD differs from the legacy passbook`);

    console.log("Refund ↔ ledger links (information only)");
    const refundLinks = await pgPool.query<{ status: string; n: number; linked: number }>(REFUND_LINK_SQL);
    for (const r of refundLinks.rows) console.log(`  ${r.status.padEnd(10)} ${r.linked} / ${r.n} linked`);

    console.log("Transfers and deposits (information only)");
    const links = (
      await pgPool.query<{
        transfers: number;
        transfer_rows_unlinked: number;
        cancel_credits_unlinked: number;
        deposits_untyped: number;
        deposits_untyped_with_utr: number;
      }>(LINK_COUNTS_SQL)
    ).rows[0]!;
    // emd_transfers is never backfilled from legacy data (no legacy transfer
    // log table exists), so transfers=0 and transfer_rows_unlinked equal to
    // the full transfer_in/transfer_out count are the expected state here.
    console.log(
      `  ${links.transfers} transfers (table, live workflow only), ${links.transfer_rows_unlinked} transfer ledger rows classified by regex (no emd_transfers link expected for legacy data)`,
    );
    console.log(`  ${links.cancel_credits_unlinked} refund_cancelled credits without a refund`);
    console.log(
      `  ${links.deposits_untyped} deposits without a payment mode (${links.deposits_untyped_with_utr} with a UTR: duplicate-UTR check cannot see them)`,
    );

    console.log("Forfeitures (information only)");
    const seededForfeits = new Set(
      (await pgPool.query<{ id: number }>("SELECT id FROM emd_forfeitures")).rows.map((r) => Number(r.id)),
    );
    const skippedForfeits = legacyForfeited.recordset.filter((f) => !seededForfeits.has(Number(f.id)));
    console.log(`  legacy ${legacyForfeited.recordset.length}, not seeded ${skippedForfeits.length}`);
    for (const f of skippedForfeits) {
      console.log(`    #${f.id} auction ${f.auctionId} bidder ${f.bidderId} amount ${f.amount}`);
    }
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }

  console.log(failures === 0 ? "\nPASS" : `\nFAILED (${failures} findings)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

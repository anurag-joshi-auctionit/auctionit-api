import { sql } from "drizzle-orm";
import { LiveBidMessages } from "@auctionit/messages/auctions";
import type { db } from "../../db/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SqlExecutor = Pick<Tx, "execute">;

/**
 * Canonical client IP for IP Address Restriction comparisons. Legacy bid logs
 * store `"<ip> | <device>"`, and Node reports IPv4 clients on dual-stack
 * sockets as `::ffff:<ipv4>`. Returns null when no usable IP is present, which
 * the restriction treats as unrestricted (legacy `len(@IPAddress) > 6`).
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let ip = String(raw).split("|")[0]!.trim();
  if (ip.toLowerCase().startsWith("::ffff:") && ip.includes(".")) {
    ip = ip.slice(7);
  }
  return ip.length > 0 ? ip : null;
}

/**
 * Serializes IP-restriction checks for one (auction, IP) pair until the
 * transaction ends. The lot row lock is per lot, so two bidders sharing an IP
 * on different lots could otherwise both pass the claimant check.
 */
export async function lockAuctionIp(
  tx: SqlExecutor,
  auctionId: number,
  ip: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ipr:${auctionId}:${ip}`}, 0))`,
  );
}

/**
 * Another bidder that has already used `ip` in this auction — via T&C
 * acceptance, any logged manual/proxy bid attempt, or an accepted sealed-bid —
 * or null. Attempts that
 * were themselves rejected for IP restriction never claim the IP.
 */
export async function findIpClaimant(
  tx: SqlExecutor,
  opts: { auctionId: number; bidderId: number; ip: string },
): Promise<number | null> {
  const res = await tx.execute<{ bidder_id: number }>(sql`
    SELECT bidder_id FROM auction_tnc_acceptances
     WHERE auction_id = ${opts.auctionId}
       AND bidder_id <> ${opts.bidderId}
       AND ip = ${opts.ip}
    UNION ALL
    SELECT bidder_id FROM auction_bid_logs
     WHERE auction_id = ${opts.auctionId}
       AND bidder_id <> ${opts.bidderId}
       AND ip IS NOT NULL
       AND btrim(split_part(ip, '|', 1)) = ${opts.ip}
       AND reject_reason IS DISTINCT FROM ${LiveBidMessages.IP_RESTRICTED}
    UNION ALL
    SELECT bidder_id FROM auction_sealed_bids
     WHERE auction_id = ${opts.auctionId}
       AND bidder_id <> ${opts.bidderId}
       AND ip = ${opts.ip}
    LIMIT 1
  `);
  const row = res.rows[0];
  return row ? Number(row.bidder_id) : null;
}

/**
 * Legacy IP Address Restriction (Proc_TnCAcceptanceUpdateIPRestriction /
 * usp_InsertManualBid_Reverse / usp_InsertProxyBid_new): when the auction flag
 * is on, one IP may be used by only one bidder company for the whole auction.
 * The same bidder may use any number of IPs. Returns true when blocked.
 *
 * `ip` must already be normalized with {@link normalizeClientIp}.
 */
export async function checkIpRestriction(
  tx: SqlExecutor,
  opts: {
    enabled: boolean | null | undefined;
    auctionId: number;
    bidderId: number;
    ip: string | null;
  },
): Promise<boolean> {
  if (opts.enabled !== true || !opts.ip) return false;
  await lockAuctionIp(tx, opts.auctionId, opts.ip);
  const claimant = await findIpClaimant(tx, {
    auctionId: opts.auctionId,
    bidderId: opts.bidderId,
    ip: opts.ip,
  });
  return claimant != null;
}

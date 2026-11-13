import { sql } from "drizzle-orm";
import { LiveBidMessages } from "@auctionit/messages/auctions";
import type { db } from "../../db/index.js";
import { checkIpRestriction } from "./ip-restriction.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * SQL fragment: true when the auction has an active T&C document that this
 * bidder hasn't accepted yet. Expects the auction aliased as `a`.
 */
export function tncBlockedSql(bidderId: number) {
  return sql`(EXISTS (SELECT 1 FROM auction_documents d
      WHERE d.auction_id = a.auction_id AND d.document_type_id = 2 AND d.is_active)
    AND NOT EXISTS (SELECT 1 FROM auction_tnc_acceptances t
      WHERE t.auction_id = a.auction_id AND t.bidder_id = ${bidderId}))`;
}

/**
 * Participation gates shared by live manual, proxy and sealed-bids: the bidder
 * must be mapped to the auction (auction-wide or this lot), not be EMD-released
 * after a reopen, have accepted the
 * T&C, and pass IP Address Restriction. Returns the reject reason, or null.
 */
export async function bidderGateError(
  tx: Tx,
  opts: {
    auctionId: number;
    lotId: number;
    bidderId: number;
    tncBlocked: boolean;
    ipRestrictionEnabled: boolean | null;
    ip: string | null;
  },
): Promise<string | null> {
  const participant = await tx.execute(sql`
    SELECT emd_released FROM auction_lot_bidder_maps
    WHERE auction_id = ${opts.auctionId}
      AND bidder_id = ${opts.bidderId}
      AND is_active = true
      AND (lot_id IS NULL OR lot_id = ${opts.lotId})
  `);
  if (participant.rows.length === 0) return LiveBidMessages.NOT_REGISTERED;
  // Reopen: a bidder released at the earlier close keeps the attachment to the
  // lot but has no EMD block on it until re-attached.
  if (participant.rows.every((r) => r.emd_released === true)) {
    return LiveBidMessages.EMD_BLOCK_REQUIRED;
  }
  if (opts.tncBlocked) return LiveBidMessages.TNC_REQUIRED;
  if (
    await checkIpRestriction(tx, {
      enabled: opts.ipRestrictionEnabled,
      auctionId: opts.auctionId,
      bidderId: opts.bidderId,
      ip: opts.ip,
    })
  ) {
    return LiveBidMessages.IP_RESTRICTED;
  }
  return null;
}

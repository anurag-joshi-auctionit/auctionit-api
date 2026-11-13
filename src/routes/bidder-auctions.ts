import { Router } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  AuctionsErrorMessages,
  AuctionsValidationMessages,
  BidderPortalAuctionMessages,
} from "@auctionit/messages/auctions";
import { BidderDashboardMessages } from "@auctionit/messages/bidder-dashboard";
import { BidderAuctionAccessMessages } from "@auctionit/messages/live";
import { requireAuth, requirePortalRole } from "../auth/middleware.js";
import { db } from "../db/index.js";
import {
  checkIpRestriction,
  normalizeClientIp,
} from "../lib/auctions/ip-restriction.js";
import { closedDateRangeQuerySchema } from "../lib/closed-auction-date-range.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  pgActiveCatalogueDownloadUrl,
  pgActiveTncDownloadUrl,
} from "../services/auctions-pg.service.js";

const router = Router();
router.use(requireAuth);
router.use(requirePortalRole("bidder"));

const listQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    bucket: z.enum(["today", "future", "closed"]).default("today"),
  }),
);

function bidderIdOf(req: import("express").Request): number | null {
  return req.user?.bidderId ?? null;
}

// True when the bidder is attached to at least one active lot of the auction
// (auction-wide map or a per-lot map).
async function bidderAttachedToAuction(
  bidderId: number,
  auctionId: number,
): Promise<boolean> {
  const r = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM auction_lot_bidder_maps m
      WHERE m.auction_id = ${auctionId} AND m.bidder_id = ${bidderId}
        AND m.is_active = true
    ) AS ok
  `);
  return r.rows[0]?.ok === true;
}

/** Catalogue is visible for published auctions even before attachment (catalogue notify). */
async function auctionIsPublished(auctionId: number): Promise<boolean> {
  const r = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM auctions a
      WHERE a.auction_id = ${auctionId}
        AND a.status = 'published'
        AND a.published_at <= now()
        AND a.is_active = true
    ) AS ok
  `);
  return r.rows[0]?.ok === true;
}

type ListRow = {
  id: number;
  auction_number: string | null;
  auction_type: string | null;
  client_id: number | null;
  client_name: string | null;
  auction_date: string;
  /** Earliest active lot start time-of-day (HH:mm:ss), or null. */
  lot_start_time: string | null;
  status: string;
  lots: number;
  bucket: "closed" | "today" | "future";
  live_state: "live" | "upcoming" | null;
  has_catalogue: boolean;
  has_tnc: boolean;
  tnc_accepted: boolean;
};

function mapListRow(r: ListRow) {
  return {
    id: r.id,
    auctionNumber: r.auction_number,
    auctionType: r.auction_type,
    clientId: r.client_id,
    clientName: r.client_name,
    auctionDate: r.auction_date,
    lotStartTime: r.lot_start_time,
    status: r.status,
    lotCount: r.lots,
    bucket: r.bucket,
    liveState: r.live_state,
    hasCatalogue: r.has_catalogue === true,
    hasTnc: r.has_tnc === true,
    tncAccepted: r.tnc_accepted === true,
  };
}

/** Shared UNION of today / future / closed rows for one bidder. */
function bidderAuctionsUnionSql(bidderId: number) {
  return sql`
        SELECT a.auction_id AS id, a.auction_number, a.auction_type,
               a.client_id,
               c.company_name AS client_name,
               to_char(a.auction_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS auction_date,
               (
                 SELECT to_char(min(l.start_time), 'HH24:MI:SS')
                 FROM auction_lots l
                 WHERE l.auction_id = a.auction_id AND l.is_active
               ) AS lot_start_time,
               a.status, m.lots,
               'today'::text AS bucket,
               CASE
                 WHEN (
                   SELECT EXTRACT(EPOCH FROM (
                     (min(a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now()
                   ))::int
                   FROM auction_lots l
                   WHERE l.auction_id = a.auction_id AND l.is_active
                 ) > 0 THEN 'upcoming'
                 ELSE 'live'
               END AS live_state,
               EXISTS (SELECT 1 FROM auction_documents d
                  WHERE d.auction_id = a.auction_id AND d.document_type_id = 1 AND d.is_active) AS has_catalogue,
               EXISTS (SELECT 1 FROM auction_documents d
                  WHERE d.auction_id = a.auction_id AND d.document_type_id = 2 AND d.is_active) AS has_tnc,
               EXISTS (SELECT 1 FROM auction_tnc_acceptances t
                  WHERE t.auction_id = a.auction_id AND t.bidder_id = ${bidderId}) AS tnc_accepted
        FROM (
          SELECT auction_id, count(*)::int AS lots
          FROM auction_lot_bidder_maps
          WHERE bidder_id = ${bidderId} AND is_active = true
          GROUP BY auction_id
        ) m
        JOIN auctions a ON a.auction_id = m.auction_id AND a.is_active = true
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.status = 'published'
          AND a.published_at <= now()
          AND a.auction_date::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
          AND (
            (
              SELECT EXTRACT(EPOCH FROM (
                (max(COALESCE(
                  l.extended_end_time,
                  (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'
                )) - now())
              ))::int
              FROM auction_lots l
              WHERE l.auction_id = a.auction_id AND l.is_active
            ) IS NULL
            OR (
              SELECT EXTRACT(EPOCH FROM (
                (max(COALESCE(
                  l.extended_end_time,
                  (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'
                )) - now())
              ))::int
              FROM auction_lots l
              WHERE l.auction_id = a.auction_id AND l.is_active
            ) > 0
          )

        UNION ALL

        SELECT a.auction_id AS id, a.auction_number, a.auction_type,
               a.client_id,
               c.company_name AS client_name,
               to_char(a.auction_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS auction_date,
               (
                 SELECT to_char(min(l.start_time), 'HH24:MI:SS')
                 FROM auction_lots l
                 WHERE l.auction_id = a.auction_id AND l.is_active
               ) AS lot_start_time,
               a.status, m.lots,
               'future'::text AS bucket,
               NULL::text AS live_state,
               EXISTS (SELECT 1 FROM auction_documents d
                  WHERE d.auction_id = a.auction_id AND d.document_type_id = 1 AND d.is_active) AS has_catalogue,
               EXISTS (SELECT 1 FROM auction_documents d
                  WHERE d.auction_id = a.auction_id AND d.document_type_id = 2 AND d.is_active) AS has_tnc,
               EXISTS (SELECT 1 FROM auction_tnc_acceptances t
                  WHERE t.auction_id = a.auction_id AND t.bidder_id = ${bidderId}) AS tnc_accepted
        FROM (
          SELECT auction_id, count(*)::int AS lots
          FROM auction_lot_bidder_maps
          WHERE bidder_id = ${bidderId} AND is_active = true
          GROUP BY auction_id
        ) m
        JOIN auctions a ON a.auction_id = m.auction_id AND a.is_active = true
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.status = 'published'
          AND a.published_at <= now()
          AND a.auction_date::date > (now() AT TIME ZONE 'Asia/Kolkata')::date

        UNION ALL

        SELECT a.auction_id AS id, a.auction_number, a.auction_type,
               a.client_id,
               c.company_name AS client_name,
               to_char(a.auction_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS auction_date,
               (
                 SELECT to_char(min(l.start_time), 'HH24:MI:SS')
                 FROM auction_lots l
                 WHERE l.auction_id = a.auction_id AND l.is_active
               ) AS lot_start_time,
               a.status,
               (SELECT count(DISTINCT ab2.lot_id)::int
                  FROM auction_bids ab2
                 WHERE ab2.auction_id = a.auction_id AND ab2.bidder_id = ${bidderId}) AS lots,
               'closed'::text AS bucket,
               NULL::text AS live_state,
               EXISTS (SELECT 1 FROM auction_documents d
                  WHERE d.auction_id = a.auction_id AND d.document_type_id = 1 AND d.is_active) AS has_catalogue,
               EXISTS (SELECT 1 FROM auction_documents d
                  WHERE d.auction_id = a.auction_id AND d.document_type_id = 2 AND d.is_active) AS has_tnc,
               EXISTS (SELECT 1 FROM auction_tnc_acceptances t
                  WHERE t.auction_id = a.auction_id AND t.bidder_id = ${bidderId}) AS tnc_accepted
        FROM (
          SELECT DISTINCT auction_id
          FROM auction_bids
          WHERE bidder_id = ${bidderId}
        ) b
        JOIN auctions a ON a.auction_id = b.auction_id AND a.is_active = true
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.status = 'closed'
  `;
}

// Buckets:
// - today: published, auction date = today IST, schedule still open (live or upcoming)
// - future: published, auction date > today IST
// - closed: status closed, where the bidder placed ≥1 bid
// Today/Future require lot-map attachment; Closed requires bid participation.
// Full bucket (unpaginated) so the portal can group by client.
router.get("/", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AuctionsValidationMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  const { bucket, from, to } = parsed.data;
  const dateClause =
    bucket === "closed" && from && to
      ? sql`AND u.auction_date::date >= CAST(${from} AS date) AND u.auction_date::date <= CAST(${to} AS date)`
      : sql``;
  try {
    const listResult = await db.execute<ListRow>(sql`
      SELECT * FROM (
        ${bidderAuctionsUnionSql(bidderId)}
      ) u
      WHERE u.bucket = ${bucket}
        ${dateClause}
      ORDER BY u.client_name NULLS LAST, u.auction_date, u.lot_start_time NULLS LAST, u.id
    `);

    const items = listResult.rows.map(mapListRow);
    if (bucket === "closed") {
      items.sort((a, b) => {
        const name = (a.clientName ?? "").localeCompare(b.clientName ?? "");
        if (name !== 0) return name;
        return b.auctionDate.localeCompare(a.auctionDate) || a.id - b.id;
      });
    }

    res.json({ items });
  } catch (e) {
    next(e);
  }
});

// Auctions the bidder is attached to that still need their T&C accepted — the
// Dashboard's "Terms & Conditions" requests list (mirrors the old app). Only
// current/upcoming published auctions (accepting T&C for a past auction is moot).
router.get("/pending-tnc", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  try {
    const result = await db.execute<{
      id: number;
      auction_number: string | null;
      client_name: string | null;
      auction_date: string;
    }>(sql`
      SELECT a.auction_id AS id, a.auction_number,
             c.company_name AS client_name,
             to_char(a.auction_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS auction_date
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.is_active = true AND a.status = 'published'
        AND a.published_at <= now()
        AND a.auction_date::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND EXISTS (SELECT 1 FROM auction_lot_bidder_maps m
              WHERE m.auction_id = a.auction_id AND m.bidder_id = ${bidderId}
                AND m.is_active = true)
        AND EXISTS (SELECT 1 FROM auction_documents d
              WHERE d.auction_id = a.auction_id AND d.document_type_id = 2 AND d.is_active)
        AND NOT EXISTS (SELECT 1 FROM auction_tnc_acceptances t
              WHERE t.auction_id = a.auction_id AND t.bidder_id = ${bidderId})
      ORDER BY a.auction_date ASC
    `);
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        auctionNumber: r.auction_number,
        clientName: r.client_name,
        auctionDate: r.auction_date,
      })),
    );
  } catch (e) {
    next(e);
  }
});

function parseAuctionId(req: import("express").Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type AuctionHeaderRow = {
  id: number;
  auction_number: string | null;
  auction_type: string | null;
  client_id: number | null;
  client_name: string | null;
  auction_date: string | null;
  status: string;
  live_state: "live" | "upcoming" | null;
};

/** Shared header columns for the auction details page. Static SQL only. */
const auctionHeaderColumns = sql.raw(`
  a.auction_id AS id,
  a.auction_number,
  a.auction_type,
  a.client_id,
  c.company_name AS client_name,
  to_char(a.auction_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS auction_date,
  a.status,
  CASE
    WHEN (
      SELECT EXTRACT(EPOCH FROM (
        (min(a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata') - now()
      ))::int
      FROM auction_lots l
      WHERE l.auction_id = a.auction_id AND l.is_active
    ) > 0 THEN 'upcoming'
    ELSE 'live'
  END AS live_state
`);

function mapAuctionHeader(auction: AuctionHeaderRow) {
  return {
    id: auction.id,
    auctionNumber: auction.auction_number,
    auctionType: auction.auction_type,
    clientId: auction.client_id,
    clientName: auction.client_name,
    auctionDate: auction.auction_date,
    status: auction.status,
    liveState: auction.live_state,
  };
}

// Redirect to a signed download URL for the auction's active Catalogue.
// Allowed for attached bidders, or any authenticated bidder when the auction
// is published (catalogue notification recipients may not be attached yet).
router.get("/:id/catalogue", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const auctionId = parseAuctionId(req);
  if (!auctionId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const allowed =
      (await bidderAttachedToAuction(bidderId, auctionId)) ||
      (await auctionIsPublished(auctionId));
    if (!allowed) {
      res.status(403).json({ error: BidderAuctionAccessMessages.NOT_ATTACHED_TO_AUCTION });
      return;
    }
    const url = await pgActiveCatalogueDownloadUrl(auctionId);
    if (!url) {
      res.status(404).json({ error: BidderAuctionAccessMessages.NO_CATALOGUE });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    next(e);
  }
});

// Redirect to a signed download URL for the auction's active Terms &
// Conditions document, gated on attachment.
router.get("/:id/tnc", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const auctionId = parseAuctionId(req);
  if (!auctionId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    if (!(await bidderAttachedToAuction(bidderId, auctionId))) {
      res.status(403).json({ error: BidderAuctionAccessMessages.NOT_ATTACHED_TO_AUCTION });
      return;
    }
    const url = await pgActiveTncDownloadUrl(auctionId);
    if (!url) {
      res.status(404).json({ error: BidderAuctionAccessMessages.NO_TNC });
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    next(e);
  }
});

// Record the bidder's acceptance of the auction's Terms & Conditions.
// Idempotent — accepting twice is a no-op (unique on auction+bidder).
router.post("/:id/accept-tnc", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const auctionId = parseAuctionId(req);
  if (!auctionId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    if (!(await bidderAttachedToAuction(bidderId, auctionId))) {
      res.status(403).json({ error: BidderAuctionAccessMessages.NOT_ATTACHED_TO_AUCTION });
      return;
    }
    const userId = req.user?.id ?? null;
    // Stored for IP Address Restriction (legacy
    // Proc_TnCAcceptanceUpdateIPRestriction): with the auction flag on, an IP
    // used here cannot be used by any other bidder in the same auction.
    const ip = normalizeClientIp(req.ip);
    const outcome = await db.transaction(async (tx) => {
      const existing = await tx.execute(sql`
        SELECT 1 FROM auction_tnc_acceptances
        WHERE auction_id = ${auctionId} AND bidder_id = ${bidderId}
        LIMIT 1
      `);
      if (existing.rows.length > 0) return "accepted" as const;

      const flag = await tx.execute<{ enabled: boolean | null }>(sql`
        SELECT ip_address_restriction_enabled AS enabled
        FROM auctions WHERE auction_id = ${auctionId}
      `);
      if (
        await checkIpRestriction(tx, {
          enabled: flag.rows[0]?.enabled,
          auctionId,
          bidderId,
          ip,
        })
      ) {
        return "ip_restricted" as const;
      }

      await tx.execute(sql`
        INSERT INTO auction_tnc_acceptances (auction_id, bidder_id, accepted_by_user_id, ip)
        VALUES (${auctionId}, ${bidderId}, ${userId}, ${ip})
        ON CONFLICT (auction_id, bidder_id) DO NOTHING
      `);
      return "accepted" as const;
    });
    if (outcome === "ip_restricted") {
      res
        .status(403)
        .json({ error: BidderPortalAuctionMessages.TNC_IP_RESTRICTED });
      return;
    }
    res.json({ ok: true, accepted: true });
  } catch (e) {
    next(e);
  }
});

/** Schedule preview of the lots this bidder is attached to. No bid amounts. */
async function assignedLots(bidderId: number, auctionId: number) {
  const lotRes = await db.execute<{
    id: number;
    lot_number: string | null;
    start_time: string | null;
    end_time: string | null;
    quantity: string | null;
    uom: string | null;
    bid_increment: string | null;
    plant_location: string | null;
    material_location: string | null;
  }>(sql`
    SELECT l.id, l.lot_number,
           to_char(l.start_time, 'HH24:MI:SS') AS start_time,
           to_char(l.end_time, 'HH24:MI:SS') AS end_time,
           l.quantity, u.code AS uom, l.bid_increment,
           pl.name AS plant_location, ml.name AS material_location
    FROM auction_lots l
    LEFT JOIN uoms u ON u.id = l.uom_id
    LEFT JOIN plant_locations pl ON pl.id = l.plant_location_id
    LEFT JOIN material_locations ml ON ml.id = l.material_location_id
    WHERE l.auction_id = ${auctionId} AND l.is_active = true
      AND EXISTS (
        SELECT 1 FROM auction_lot_bidder_maps m
        WHERE m.auction_id = l.auction_id
          AND m.bidder_id = ${bidderId}
          AND m.is_active = true
          AND (m.lot_id IS NULL OR m.lot_id = l.id)
      )
    ORDER BY l.display_order NULLS LAST, l.id
  `);
  return lotRes.rows.map((r) => ({
    id: r.id,
    lotNumber: r.lot_number,
    startTime: r.start_time,
    endTime: r.end_time,
    quantity: r.quantity != null ? Number(r.quantity) : null,
    uom: r.uom,
    bidIncrement: r.bid_increment != null ? Number(r.bid_increment) : null,
    plantLocation: r.plant_location,
    materialLocation: r.material_location,
  }));
}

/** Only lots this bidder bid on, with their chronologically last bid amount. */
async function participatedLots(bidderId: number, auctionId: number) {
  const lotRes = await db.execute<{
    id: number;
    lot_number: string | null;
    quantity: string | null;
    uom: string | null;
    plant_location: string | null;
    material_location: string | null;
    winning_amount: string | null;
    winner_bidder_id: number | null;
    my_last_bid: string | null;
  }>(sql`
    SELECT l.id, l.lot_number, l.quantity, u.code AS uom,
           pl.name AS plant_location, ml.name AS material_location,
           l.winning_amount, l.winner_bidder_id,
           (
             SELECT ab.amount FROM auction_bids ab
             WHERE ab.lot_id = l.id AND ab.bidder_id = ${bidderId}
             ORDER BY ab.created_at DESC, ab.id DESC
             LIMIT 1
           ) AS my_last_bid
    FROM auction_lots l
    JOIN auctions a ON a.auction_id = l.auction_id
    LEFT JOIN uoms u ON u.id = l.uom_id
    LEFT JOIN plant_locations pl ON pl.id = l.plant_location_id
    LEFT JOIN material_locations ml ON ml.id = l.material_location_id
    WHERE l.auction_id = ${auctionId} AND l.is_active = true
      AND EXISTS (
        SELECT 1 FROM auction_bids ab
        WHERE ab.lot_id = l.id AND ab.bidder_id = ${bidderId}
      )
    ORDER BY l.display_order NULLS LAST, l.id
  `);
  return lotRes.rows.map((r) => ({
    id: r.id,
    lotNumber: r.lot_number,
    quantity: r.quantity != null ? Number(r.quantity) : null,
    uom: r.uom,
    plantLocation: r.plant_location,
    materialLocation: r.material_location,
    myLastBid: r.my_last_bid != null ? Number(r.my_last_bid) : null,
    winningAmount: r.winning_amount != null ? Number(r.winning_amount) : null,
    winnerBidderId: r.winner_bidder_id,
  }));
}

// Auction details page. The auction's own status picks the payload, so a
// bidder cannot switch views from the client: published auctions expose the
// schedule of their assigned lots, closed auctions expose only the lots they
// bid on. Anything else is not theirs to see.
router.get("/:id", async (req, res, next) => {
  const bidderId = bidderIdOf(req);
  if (!bidderId) {
    res.status(403).json({ error: BidderDashboardMessages.NOT_A_BIDDER });
    return;
  }
  const auctionId = parseAuctionId(req);
  if (!auctionId) {
    res.status(400).json({ error: AuctionsErrorMessages.INVALID_AUCTION_ID });
    return;
  }
  try {
    const headerRes = await db.execute<AuctionHeaderRow>(sql`
      SELECT ${auctionHeaderColumns}
      FROM auctions a
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.auction_id = ${auctionId} AND a.is_active = true
        -- A published auction stays hidden from the bidder until its
        -- scheduled publish time; other statuses are unaffected.
        AND (a.status != 'published' OR a.published_at <= now())
      LIMIT 1
    `);
    const auction = headerRes.rows[0];
    if (!auction) {
      res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
      return;
    }

    if (auction.status === "published") {
      if (!(await bidderAttachedToAuction(bidderId, auctionId))) {
        res.status(403).json({ error: BidderAuctionAccessMessages.NOT_ATTACHED_TO_AUCTION });
        return;
      }
      res.json({
        view: "assigned",
        auction: mapAuctionHeader(auction),
        lots: await assignedLots(bidderId, auctionId),
      });
      return;
    }

    if (auction.status === "closed") {
      const participated = await db.execute<{ ok: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM auction_bids ab
          WHERE ab.auction_id = ${auctionId} AND ab.bidder_id = ${bidderId}
        ) AS ok
      `);
      if (participated.rows[0]?.ok !== true) {
        res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
        return;
      }
      res.json({
        view: "participated",
        auction: mapAuctionHeader(auction),
        lots: await participatedLots(bidderId, auctionId),
      });
      return;
    }

    res.status(404).json({ error: AuctionsErrorMessages.AUCTION_NOT_FOUND });
  } catch (e) {
    next(e);
  }
});

export default router;

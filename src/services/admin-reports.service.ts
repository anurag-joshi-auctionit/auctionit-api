import { AdminReportsMessages } from "@auctionit/messages/reports";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { blockedOnAuctionSql } from "../lib/emd/blocked.js";
import {
  type AuctionReportMeta,
  queryAuctionReportMeta,
} from "../lib/reports/auction-report-meta.js";
import {
  auctionAdditionalFieldsService,
  type ReportAdditionalFieldColumn,
} from "./auction-additional-fields.service.js";

export class AdminReportsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminReportsNotFoundError";
  }
}

export type AdminReportAuctionOption = {
  auctionId: number;
  auctionNumber: string | null;
  auctionDate: string | null;
};

export type BidOverviewReportRow = {
  auctionNumber: string | null;
  auctionDate: string | null;
  lotNumber: string | null;
  plantLocationName: string | null;
  quantity: number | null;
  unit: string | null;
  startBidPrice: number | null;
  startTime: string | null;
  endTime: string | null;
  winningBidder: string | null;
  winningPrice: number | null;
  bidCount: number;
  bidderCount: number;
};

export type AdminBidDetailsReportRow = {
  auctionNumber: string | null;
  auctionDate: string | null;
  auctionType: string | null;
  lotNumber: string | null;
  startBidPrice: number | null;
  startTime: string | null;
  endTime: string | null;
  bidderName: string | null;
  username: string | null;
  bidTime: string | null;
  bidBasis: string | null;
  bidPrice: number | null;
  bidType: string;
  quantity: number | null;
};

export type BidderDetailsReportRow = {
  clientName: string | null;
  auctionNumber: string | null;
  auctionDate: string | null;
  bidderName: string | null;
  username: string | null;
  bidderId: number;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  lastLoginAt: string | null;
  lastLogoutAt: string | null;
  placedBid: boolean;
  isNew: boolean;
  tncAcceptedAt: string | null;
};

/** Per-auction bidder aggregate metrics (Bidder Overview report). */
export type BidderOverviewReportRow = {
  clientName: string | null;
  auctionNumber: string | null;
  auctionDate: string | null;
  attached: number;
  loggedIn: number;
  participated: number;
  winners: number;
  newAttached: number;
  newParticipated: number;
  newWinners: number;
};

/** Per-lot closed-auction overview (Auction Overview report). */
export type AuctionOverviewReportRow = {
  clientName: string | null;
  auctionNumber: string | null;
  auctionDate: string | null;
  lotNumber: string | null;
  startTime: string | null;
  endTime: string | null;
  quantity: number | null;
  unit: string | null;
  startBidPrice: number | null;
  bidIncrement: number | null;
  winningPrice: number | null;
  winningBidder: string | null;
  bidCount: number;
  bidderCount: number;
};

/** Combined Auction Details report (legacy AuctionReport equivalent). */
export type AuctionDetailsMeta = AuctionReportMeta;

export type AuctionDetailsSummaryRow = {
  lotId: number;
  lotNumber: string | null;
  startTime: string | null;
  endTime: string | null;
  clientName: string | null;
  plantLocationName: string | null;
  product: string | null;
  quantity: number | null;
  unit: string | null;
  startBidPrice: number | null;
  bidIncrement: number | null;
  winningPrice: number | null;
  winningBidder: string | null;
  bidCount: number;
  bidderCount: number;
  /** Client additional field display values keyed by `additionalFields[].key`. */
  additionalValues: Record<string, string>;
};

export type AuctionDetailsBidRow = {
  lotId: number;
  lotNumber: string | null;
  product: string | null;
  quantity: number | null;
  unit: string | null;
  clientName: string | null;
  bidTime: string | null;
  bidderName: string | null;
  bidAmount: number | null;
  bidType: string;
};

export type AuctionDetailsParticipantRow = {
  companyName: string | null;
  city: string | null;
  emdBalance: number | null;
};

export type AuctionDetailsReport = {
  meta: AuctionDetailsMeta;
  /** Dynamic summary columns (auction-level values repeat on every lot row). */
  additionalFields: ReportAdditionalFieldColumn[];
  summary: AuctionDetailsSummaryRow[];
  bids: AuctionDetailsBidRow[];
  participants: AuctionDetailsParticipantRow[];
};

export type BidOverviewMode = "bid" | "no-bid";

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function assertClosedAuction(
  clientId: number,
  auctionId: number,
): Promise<void> {
  const res = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM auctions a
      WHERE a.auction_id = ${auctionId}
        AND a.client_id = ${clientId}
        AND a.status = 'closed'
        AND a.is_active = true
    ) AS ok
  `);
  if (res.rows[0]?.ok !== true) {
    throw new AdminReportsNotFoundError(AdminReportsMessages.AUCTION_NOT_FOUND);
  }
}

class AdminReportsService {
  async auctionReportMeta(
    clientId: number,
    auctionId: number,
  ): Promise<AuctionReportMeta> {
    await assertClosedAuction(clientId, auctionId);
    return queryAuctionReportMeta(clientId, auctionId);
  }

  async listAuctions(
    clientIds: number[],
    range: { from: string; to: string },
  ): Promise<AdminReportAuctionOption[]> {
    if (clientIds.length === 0) return [];
    const clientFilter = sql`AND a.client_id IN (${sql.join(
      clientIds.map((id) => sql`${id}`),
      sql`, `,
    )})`;
    const res = await db.execute<{
      auction_id: number;
      auction_number: string | null;
      auction_date: string | null;
    }>(sql`
      SELECT a.auction_id, a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date
      FROM auctions a
      WHERE a.status = 'closed'
        AND a.is_active = true
        AND a.auction_date::date >= CAST(${range.from} AS date)
        AND a.auction_date::date <= CAST(${range.to} AS date)
        ${clientFilter}
      ORDER BY a.auction_date DESC, a.auction_id DESC
    `);
    return res.rows.map((r) => ({
      auctionId: r.auction_id,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
    }));
  }

  async bidOverviewReport(opts: {
    from: string;
    to: string;
    clientIds?: number[];
    auctionIds?: number[];
    bidMode?: BidOverviewMode;
  }): Promise<BidOverviewReportRow[]> {
    const clientIds = opts.clientIds?.length ? opts.clientIds : null;
    const auctionIds = opts.auctionIds?.length ? opts.auctionIds : null;
    const clientFilter =
      clientIds != null
        ? sql`AND a.client_id IN (${sql.join(
            clientIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``;
    const auctionFilter =
      auctionIds != null
        ? sql`AND a.auction_id IN (${sql.join(
            auctionIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``;

    let lotFilter = sql`AND (
      l.bid_count = 0
      OR (l.winner_bidder_id IS NOT NULL AND l.winning_amount IS NOT NULL)
    )`;
    if (opts.bidMode === "no-bid") {
      lotFilter = sql`AND l.bid_count = 0`;
    } else if (opts.bidMode === "bid") {
      lotFilter = sql`AND l.winner_bidder_id IS NOT NULL AND l.winning_amount IS NOT NULL`;
    }

    const res = await db.execute<{
      auction_number: string | null;
      auction_date: string | null;
      lot_number: string | null;
      plant_location_name: string | null;
      quantity: string | null;
      unit: string | null;
      start_bid_price: string | null;
      start_time: string | null;
      end_time: string | null;
      winning_bidder: string | null;
      winning_amount: string | null;
      bid_count: number;
      bidder_count: number;
    }>(sql`
      SELECT a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
             l.lot_number,
             pl.name AS plant_location_name,
             l.quantity,
             u.code AS unit,
             l.start_bid_price,
             to_char((a.auction_date::date + l.start_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(
               COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)),
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS end_time,
             wb.company_name AS winning_bidder,
             l.winning_amount,
             l.bid_count,
             l.bidder_count
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      LEFT JOIN plant_locations pl ON pl.id = l.plant_location_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN bidders wb ON wb.id = l.winner_bidder_id
      WHERE a.status = 'closed'
        AND a.is_active = true
        AND l.is_active = true
        AND a.auction_date::date >= CAST(${opts.from} AS date)
        AND a.auction_date::date <= CAST(${opts.to} AS date)
        ${clientFilter}
        ${auctionFilter}
        ${lotFilter}
      ORDER BY a.auction_date DESC, a.auction_id DESC,
               l.display_order NULLS LAST, l.id
    `);

    return res.rows.map((r) => ({
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
      lotNumber: r.lot_number,
      plantLocationName: r.plant_location_name,
      quantity: num(r.quantity),
      unit: r.unit,
      startBidPrice: num(r.start_bid_price),
      startTime: r.start_time,
      endTime: r.end_time,
      winningBidder: r.winning_bidder,
      winningPrice: num(r.winning_amount),
      bidCount: r.bid_count ?? 0,
      bidderCount: r.bidder_count ?? 0,
    }));
  }

  async bidDetailsReport(
    clientId: number,
    auctionId: number,
  ): Promise<AdminBidDetailsReportRow[]> {
    await assertClosedAuction(clientId, auctionId);
    const res = await db.execute<{
      auction_number: string | null;
      auction_date: string | null;
      auction_type: string | null;
      lot_number: string | null;
      start_bid_price: string | null;
      start_time: string | null;
      end_time: string | null;
      bidder_name: string | null;
      username: string | null;
      bid_time: string | null;
      bid_basis: string | null;
      bid_price: string | null;
      is_proxy: boolean;
      bid_quantity: string | null;
      lot_quantity: string | null;
    }>(sql`
      SELECT a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
             a.auction_type,
             l.lot_number,
             l.start_bid_price,
             to_char((a.auction_date::date + l.start_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(
               COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)),
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS end_time,
             b.company_name AS bidder_name,
             usr.user_login_name AS username,
             to_char(ab.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS bid_time,
             u.code AS bid_basis,
             ab.amount AS bid_price,
             ab.is_proxy,
             ab.quantity AS bid_quantity,
             l.quantity AS lot_quantity
      FROM auction_bids ab
      JOIN auctions a ON a.auction_id = ab.auction_id
      JOIN auction_lots l ON l.id = ab.lot_id
      LEFT JOIN bidders b ON b.id = ab.bidder_id
      LEFT JOIN users usr ON usr.id = ab.user_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      WHERE ab.auction_id = ${auctionId}
        AND l.is_active = true
      ORDER BY l.display_order NULLS LAST, l.id, ab.created_at ASC, ab.id ASC
    `);
    return res.rows.map((r) => ({
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
      auctionType: r.auction_type,
      lotNumber: r.lot_number,
      startBidPrice: num(r.start_bid_price),
      startTime: r.start_time,
      endTime: r.end_time,
      bidderName: r.bidder_name,
      username: r.username,
      bidTime: r.bid_time,
      bidBasis: r.bid_basis,
      bidPrice: num(r.bid_price),
      bidType: r.is_proxy ? "Proxy" : "Manual",
      quantity: num(r.bid_quantity) ?? num(r.lot_quantity),
    }));
  }

  async bidderDetailsReport(
    clientId: number,
    auctionId: number,
  ): Promise<BidderDetailsReportRow[]> {
    await assertClosedAuction(clientId, auctionId);
    const res = await db.execute<{
      client_name: string | null;
      auction_number: string | null;
      auction_date: string | null;
      bidder_name: string | null;
      username: string | null;
      bidder_id: number;
      company_name: string | null;
      phone: string | null;
      email: string | null;
      last_login_at: string | null;
      last_logout_at: string | null;
      placed_bid: boolean;
      is_new: boolean;
      tnc_accepted_at: string | null;
    }>(sql`
      SELECT DISTINCT ON (b.id)
             c.company_name AS client_name,
             a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
             u.name AS bidder_name,
             u.user_login_name AS username,
             b.id AS bidder_id,
             b.company_name,
             u.phone_number AS phone,
             u.email_id AS email,
             to_char(
               u.last_login_at AT TIME ZONE 'Asia/Kolkata',
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS last_login_at,
             to_char(
               u.last_logout_at AT TIME ZONE 'Asia/Kolkata',
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS last_logout_at,
             EXISTS (
               SELECT 1
               FROM auction_bids ab
               WHERE ab.auction_id = ${auctionId}
                 AND ab.bidder_id = b.id
             ) AS placed_bid,
             NOT EXISTS (
               SELECT 1
               FROM auction_bids ab_prior
               JOIN auctions a_prior ON a_prior.auction_id = ab_prior.auction_id
               WHERE ab_prior.bidder_id = b.id
                 AND a_prior.client_id = ${clientId}
                 AND a_prior.auction_id <> ${auctionId}
                 AND a_prior.is_active = true
             ) AS is_new,
             to_char(
               tnc.accepted_at AT TIME ZONE 'Asia/Kolkata',
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS tnc_accepted_at
      FROM auction_lot_bidder_maps m
      JOIN auctions a ON a.auction_id = m.auction_id
      JOIN clients c ON c.id = a.client_id
      JOIN bidders b ON b.id = m.bidder_id
      LEFT JOIN users u ON u.bidder_id = b.id
      LEFT JOIN auction_tnc_acceptances tnc
        ON tnc.auction_id = ${auctionId}
       AND tnc.bidder_id = b.id
      WHERE m.auction_id = ${auctionId}
        AND m.is_active = true
      ORDER BY b.id, b.company_name NULLS LAST, u.name NULLS LAST
    `);
    return res.rows
      .map((r) => ({
        clientName: r.client_name,
        auctionNumber: r.auction_number,
        auctionDate: r.auction_date,
        bidderName: r.bidder_name,
        username: r.username,
        bidderId: r.bidder_id,
        companyName: r.company_name,
        phone: r.phone,
        email: r.email,
        lastLoginAt: r.last_login_at,
        lastLogoutAt: r.last_logout_at,
        placedBid: r.placed_bid === true,
        isNew: r.is_new === true,
        tncAcceptedAt: r.tnc_accepted_at,
      }))
      .sort((a, b) =>
        (a.companyName ?? "").localeCompare(b.companyName ?? "", undefined, {
          sensitivity: "base",
        }),
      );
  }

  async bidderOverviewReport(opts: {
    from: string;
    to: string;
    clientIds?: number[];
    auctionIds?: number[];
  }): Promise<BidderOverviewReportRow[]> {
    const clientIds = opts.clientIds?.length ? opts.clientIds : null;
    const auctionIds = opts.auctionIds?.length ? opts.auctionIds : null;
    const clientFilter =
      clientIds != null
        ? sql`AND a.client_id IN (${sql.join(
            clientIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``;
    const auctionFilter =
      auctionIds != null
        ? sql`AND a.auction_id IN (${sql.join(
            auctionIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``;

    const res = await db.execute<{
      client_name: string | null;
      auction_number: string | null;
      auction_date: string | null;
      attached: number;
      logged_in: number;
      participated: number;
      winners: number;
      new_attached: number;
      new_participated: number;
      new_winners: number;
    }>(sql`
      WITH scoped AS (
        SELECT a.auction_id,
               a.client_id,
               c.company_name AS client_name,
               a.auction_number,
               to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date
        FROM auctions a
        JOIN clients c ON c.id = a.client_id
        WHERE a.status = 'closed'
          AND a.is_active = true
          AND a.auction_date::date >= CAST(${opts.from} AS date)
          AND a.auction_date::date <= CAST(${opts.to} AS date)
          ${clientFilter}
          ${auctionFilter}
      ),
      attached AS (
        SELECT DISTINCT m.auction_id, m.bidder_id, s.client_id
        FROM auction_lot_bidder_maps m
        JOIN scoped s ON s.auction_id = m.auction_id
        WHERE m.is_active = true
      ),
      participated AS (
        SELECT DISTINCT ab.auction_id, ab.bidder_id, s.client_id
        FROM auction_bids ab
        JOIN scoped s ON s.auction_id = ab.auction_id
      ),
      winners AS (
        SELECT DISTINCT l.auction_id, l.winner_bidder_id AS bidder_id, s.client_id
        FROM auction_lots l
        JOIN scoped s ON s.auction_id = l.auction_id
        WHERE l.is_active = true
          AND l.winner_bidder_id IS NOT NULL
          AND l.winning_amount IS NOT NULL
      ),
      logged_in AS (
        SELECT DISTINCT t.auction_id, t.bidder_id
        FROM auction_tnc_acceptances t
        JOIN attached att
          ON att.auction_id = t.auction_id
         AND att.bidder_id = t.bidder_id
      ),
      is_new AS (
        SELECT att.auction_id, att.bidder_id
        FROM attached att
        WHERE NOT EXISTS (
          SELECT 1
          FROM auction_bids ab_prior
          JOIN auctions a_prior ON a_prior.auction_id = ab_prior.auction_id
          WHERE ab_prior.bidder_id = att.bidder_id
            AND a_prior.client_id = att.client_id
            AND a_prior.auction_id <> att.auction_id
            AND a_prior.is_active = true
        )
      )
      SELECT s.client_name,
             s.auction_number,
             s.auction_date,
             (SELECT COUNT(*)::int FROM attached att WHERE att.auction_id = s.auction_id) AS attached,
             (SELECT COUNT(*)::int FROM logged_in li WHERE li.auction_id = s.auction_id) AS logged_in,
             (SELECT COUNT(*)::int FROM participated p WHERE p.auction_id = s.auction_id) AS participated,
             (SELECT COUNT(*)::int FROM winners w WHERE w.auction_id = s.auction_id) AS winners,
             (SELECT COUNT(*)::int
              FROM attached att
              JOIN is_new n
                ON n.auction_id = att.auction_id AND n.bidder_id = att.bidder_id
              WHERE att.auction_id = s.auction_id) AS new_attached,
             (SELECT COUNT(*)::int
              FROM participated p
              JOIN is_new n
                ON n.auction_id = p.auction_id AND n.bidder_id = p.bidder_id
              WHERE p.auction_id = s.auction_id) AS new_participated,
             (SELECT COUNT(*)::int
              FROM winners w
              JOIN is_new n
                ON n.auction_id = w.auction_id AND n.bidder_id = w.bidder_id
              WHERE w.auction_id = s.auction_id) AS new_winners
      FROM scoped s
      ORDER BY s.auction_date DESC, s.auction_id DESC
    `);

    return res.rows.map((r) => ({
      clientName: r.client_name,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
      attached: r.attached ?? 0,
      loggedIn: r.logged_in ?? 0,
      participated: r.participated ?? 0,
      winners: r.winners ?? 0,
      newAttached: r.new_attached ?? 0,
      newParticipated: r.new_participated ?? 0,
      newWinners: r.new_winners ?? 0,
    }));
  }

  async auctionOverviewReport(opts: {
    from: string;
    to: string;
    clientIds?: number[];
    auctionIds?: number[];
  }): Promise<AuctionOverviewReportRow[]> {
    const clientIds = opts.clientIds?.length ? opts.clientIds : null;
    const auctionIds = opts.auctionIds?.length ? opts.auctionIds : null;
    const clientFilter =
      clientIds != null
        ? sql`AND a.client_id IN (${sql.join(
            clientIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``;
    const auctionFilter =
      auctionIds != null
        ? sql`AND a.auction_id IN (${sql.join(
            auctionIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``;

    const res = await db.execute<{
      client_name: string | null;
      auction_number: string | null;
      auction_date: string | null;
      lot_number: string | null;
      start_time: string | null;
      end_time: string | null;
      quantity: string | null;
      unit: string | null;
      start_bid_price: string | null;
      bid_increment: string | null;
      winning_amount: string | null;
      winning_bidder: string | null;
      bid_count: number;
      bidder_count: number;
    }>(sql`
      SELECT c.company_name AS client_name,
             a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
             l.lot_number,
             to_char((a.auction_date::date + l.start_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(
               COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)),
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS end_time,
             l.quantity,
             u.code AS unit,
             l.start_bid_price,
             l.bid_increment,
             l.winning_amount,
             wb.company_name AS winning_bidder,
             l.bid_count,
             l.bidder_count
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      JOIN clients c ON c.id = a.client_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN bidders wb ON wb.id = l.winner_bidder_id
      WHERE a.status = 'closed'
        AND a.is_active = true
        AND l.is_active = true
        AND a.auction_date::date >= CAST(${opts.from} AS date)
        AND a.auction_date::date <= CAST(${opts.to} AS date)
        ${clientFilter}
        ${auctionFilter}
      ORDER BY a.auction_date DESC, a.auction_id DESC,
               l.display_order NULLS LAST, l.id
    `);

    return res.rows.map((r) => ({
      clientName: r.client_name,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
      lotNumber: r.lot_number,
      startTime: r.start_time,
      endTime: r.end_time,
      quantity: num(r.quantity),
      unit: r.unit,
      startBidPrice: num(r.start_bid_price),
      bidIncrement: num(r.bid_increment),
      winningPrice: num(r.winning_amount),
      winningBidder: r.winning_bidder,
      bidCount: r.bid_count ?? 0,
      bidderCount: r.bidder_count ?? 0,
    }));
  }

  async auctionDetailsReport(
    clientId: number,
    auctionId: number,
  ): Promise<AuctionDetailsReport> {
    await assertClosedAuction(clientId, auctionId);

    const [meta, additional] = await Promise.all([
      queryAuctionReportMeta(clientId, auctionId),
      auctionAdditionalFieldsService.loadAdditionalFieldColumns(auctionId),
    ]);

    const summaryRes = await db.execute<{
      lot_id: number;
      lot_number: string | null;
      start_time: string | null;
      end_time: string | null;
      client_name: string | null;
      plant_location_name: string | null;
      product: string | null;
      quantity: string | null;
      unit: string | null;
      start_bid_price: string | null;
      bid_increment: string | null;
      winning_amount: string | null;
      winning_bidder: string | null;
      bid_count: number;
      bidder_count: number;
    }>(sql`
      SELECT l.id AS lot_id,
             l.lot_number,
             to_char((a.auction_date::date + l.start_time), 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(
               COALESCE(l.extended_end_time, (a.auction_date::date + l.end_time)),
               'YYYY-MM-DD"T"HH24:MI:SS'
             ) AS end_time,
             c.company_name AS client_name,
             pl.name AS plant_location_name,
             prod.product,
             l.quantity,
             u.code AS unit,
             l.start_bid_price,
             l.bid_increment,
             l.winning_amount,
             wb.company_name AS winning_bidder,
             l.bid_count,
             l.bidder_count
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      JOIN clients c ON c.id = a.client_id
      LEFT JOIN plant_locations pl ON pl.id = l.plant_location_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN bidders wb ON wb.id = l.winner_bidder_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 NULLIF(TRIM(i.name), ''),
                 NULLIF(TRIM(ali.material_name), ''),
                 NULLIF(TRIM(ali.material_description), '')
               ) AS product
        FROM auction_lot_items ali
        LEFT JOIN items i ON i.id = ali.item_id
        WHERE ali.lot_id = l.id
          AND ali.is_active = true
        ORDER BY ali.id
        LIMIT 1
      ) prod ON true
      WHERE l.auction_id = ${auctionId}
        AND l.is_active = true
      ORDER BY l.display_order NULLS LAST, l.id
    `);

    const summary: AuctionDetailsSummaryRow[] = summaryRes.rows.map((r) => ({
      lotId: r.lot_id,
      lotNumber: r.lot_number,
      startTime: r.start_time,
      endTime: r.end_time,
      clientName: r.client_name,
      plantLocationName: r.plant_location_name,
      product: r.product,
      quantity: num(r.quantity),
      unit: r.unit,
      startBidPrice: num(r.start_bid_price),
      bidIncrement: num(r.bid_increment),
      winningPrice: num(r.winning_amount),
      winningBidder: r.winning_bidder,
      bidCount: r.bid_count ?? 0,
      bidderCount: r.bidder_count ?? 0,
      additionalValues: {
        ...additional.auctionValues,
        ...additional.lotValues.get(r.lot_id),
      },
    }));

    const bidsRes = await db.execute<{
      lot_id: number;
      lot_number: string | null;
      product: string | null;
      quantity: string | null;
      unit: string | null;
      client_name: string | null;
      bid_time: string | null;
      bidder_name: string | null;
      bid_amount: string | null;
      is_proxy: boolean;
    }>(sql`
      SELECT l.id AS lot_id,
             l.lot_number,
             prod.product,
             l.quantity,
             u.code AS unit,
             c.company_name AS client_name,
             to_char(ab.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS bid_time,
             b.company_name AS bidder_name,
             ab.amount AS bid_amount,
             ab.is_proxy
      FROM auction_bids ab
      JOIN auctions a ON a.auction_id = ab.auction_id
      JOIN clients c ON c.id = a.client_id
      JOIN auction_lots l ON l.id = ab.lot_id
      LEFT JOIN bidders b ON b.id = ab.bidder_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 NULLIF(TRIM(i.name), ''),
                 NULLIF(TRIM(ali.material_name), ''),
                 NULLIF(TRIM(ali.material_description), '')
               ) AS product
        FROM auction_lot_items ali
        LEFT JOIN items i ON i.id = ali.item_id
        WHERE ali.lot_id = l.id
          AND ali.is_active = true
        ORDER BY ali.id
        LIMIT 1
      ) prod ON true
      WHERE ab.auction_id = ${auctionId}
        AND l.is_active = true
      ORDER BY l.display_order NULLS LAST, l.id, ab.created_at ASC, ab.id ASC
    `);

    const bids: AuctionDetailsBidRow[] = bidsRes.rows.map((r) => ({
      lotId: r.lot_id,
      lotNumber: r.lot_number,
      product: r.product,
      quantity: num(r.quantity),
      unit: r.unit,
      clientName: r.client_name,
      bidTime: r.bid_time,
      bidderName: r.bidder_name,
      bidAmount: num(r.bid_amount),
      bidType: r.is_proxy ? "Proxy" : "Manual",
    }));

    const participantsRes = await db.execute<{
      company_name: string | null;
      city: string | null;
      emd_balance: string | null;
    }>(sql`
      SELECT DISTINCT ON (b.id)
             b.company_name,
             b.city,
             GREATEST(COALESCE(bk.blocked, 0), 0) AS emd_balance
      FROM auction_lot_bidder_maps m
      JOIN bidders b ON b.id = m.bidder_id
      LEFT JOIN (${blockedOnAuctionSql(auctionId, null)}) bk
        ON bk.bidder_id = m.bidder_id
      WHERE m.auction_id = ${auctionId}
        AND m.is_active = true
      ORDER BY b.id, b.company_name NULLS LAST
    `);

    const participants: AuctionDetailsParticipantRow[] = participantsRes.rows
      .map((r) => ({
        companyName: r.company_name,
        city: r.city,
        emdBalance: num(r.emd_balance),
      }))
      .sort((a, b) =>
        (a.companyName ?? "").localeCompare(b.companyName ?? "", undefined, {
          sensitivity: "base",
        }),
      );

    return {
      meta,
      additionalFields: additional.columns,
      summary,
      bids,
      participants,
    };
  }
}

export const adminReportsService = new AdminReportsService();

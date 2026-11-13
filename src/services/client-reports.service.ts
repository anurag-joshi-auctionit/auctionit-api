import { ClientReportsMessages } from "@auctionit/messages/reports";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  type AuctionReportMeta,
  queryAuctionReportMeta,
} from "../lib/reports/auction-report-meta.js";

export class ClientReportsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientReportsAccessError";
  }
}

export class ClientReportsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientReportsNotFoundError";
  }
}

export type ReportClientOption = {
  clientId: number;
  companyName: string;
};

export type ReportAuctionOption = {
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

export type BidDetailsReportRow = {
  auctionNumber: string | null;
  auctionDate: string | null;
  auctionType: string | null;
  lotNumber: string | null;
  startBidPrice: number | null;
  startTime: string | null;
  endTime: string | null;
  bidderName: string | null;
  bidTime: string | null;
  bidBasis: string | null;
  bidPrice: number | null;
  bidType: string;
  quantity: number | null;
};

export type BidOverviewMode = "bid" | "no-bid";

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function assertUserClientAccess(
  userId: number,
  clientId: number,
): Promise<void> {
  const res = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM user_clients uc
      WHERE uc.user_id = ${userId}
        AND uc.client_id = ${clientId}
        AND uc.is_active = true
    ) AS ok
  `);
  if (res.rows[0]?.ok !== true) {
    throw new ClientReportsAccessError(ClientReportsMessages.CLIENT_FORBIDDEN);
  }
}

async function assertClosedAuctionAccess(
  userId: number,
  clientId: number,
  auctionId: number,
): Promise<void> {
  await assertUserClientAccess(userId, clientId);
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
    throw new ClientReportsNotFoundError(ClientReportsMessages.AUCTION_NOT_FOUND);
  }
}

class ClientReportsService {
  async listClients(userId: number): Promise<ReportClientOption[]> {
    const res = await db.execute<{
      client_id: number;
      company_name: string;
    }>(sql`
      SELECT c.id AS client_id, c.company_name
      FROM clients c
      INNER JOIN user_clients uc
        ON uc.client_id = c.id AND uc.user_id = ${userId} AND uc.is_active = true
      WHERE c.is_active = true
      ORDER BY c.company_name ASC, c.id ASC
    `);
    return res.rows.map((r) => ({
      clientId: r.client_id,
      companyName: r.company_name,
    }));
  }

  async listAuctions(
    userId: number,
    clientIds: number[],
    range: { from: string; to: string },
  ): Promise<ReportAuctionOption[]> {
    if (clientIds.length === 0) return [];
    for (const clientId of clientIds) {
      await assertUserClientAccess(userId, clientId);
    }
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

  async bidOverviewReport(
    userId: number,
    opts: {
      from: string;
      to: string;
      clientIds?: number[];
      auctionIds?: number[];
      bidMode?: BidOverviewMode;
    },
  ): Promise<BidOverviewReportRow[]> {
    const clientIds = opts.clientIds?.length ? opts.clientIds : null;
    const auctionIds = opts.auctionIds?.length ? opts.auctionIds : null;

    if (clientIds != null) {
      for (const clientId of clientIds) {
        await assertUserClientAccess(userId, clientId);
      }
    }

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
      INNER JOIN user_clients uc
        ON uc.client_id = a.client_id
       AND uc.user_id = ${userId}
       AND uc.is_active = true
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

  async auctionReportMeta(
    userId: number,
    clientId: number,
    auctionId: number,
  ): Promise<AuctionReportMeta> {
    await assertClosedAuctionAccess(userId, clientId, auctionId);
    return queryAuctionReportMeta(clientId, auctionId);
  }

  async bidDetailsReport(
    userId: number,
    clientId: number,
    auctionId: number,
  ): Promise<BidDetailsReportRow[]> {
    await assertClosedAuctionAccess(userId, clientId, auctionId);
    const res = await db.execute<{
      auction_number: string | null;
      auction_date: string | null;
      auction_type: string | null;
      lot_number: string | null;
      start_bid_price: string | null;
      start_time: string | null;
      end_time: string | null;
      bidder_name: string | null;
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
      bidTime: r.bid_time,
      bidBasis: r.bid_basis,
      bidPrice: num(r.bid_price),
      bidType: r.is_proxy ? "Proxy" : "Manual",
      quantity: num(r.bid_quantity) ?? num(r.lot_quantity),
    }));
  }
}

export const clientReportsService = new ClientReportsService();

import { AdminReportsMessages } from "@auctionit/messages/reports";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  type AuctionReportMeta,
  queryAuctionReportMeta,
} from "../lib/reports/auction-report-meta.js";
import {
  AdminReportsNotFoundError,
  type AdminReportAuctionOption,
} from "./admin-reports.service.js";

/** Per-lot sealed-bid summary (Sealed-Bid report). */
export type SealedBidReportRow = {
  lotId: number;
  clientId: number;
  clientName: string | null;
  auctionNumber: string | null;
  auctionDate: string | null;
  lotNumber: string | null;
  uom: string | null;
  sealedBidDate: string | null;
  /** IST wall-clock `YYYY-MM-DDTHH:MM:SS`. */
  startTime: string | null;
  endTime: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  avgAmount: number | null;
  bidderCount: number;
  winningBidder: string | null;
  winningAmount: number | null;
};

/** Published or closed sealed-bid auctions (the window may still be upcoming). */
const SEALED_AUCTION_SCOPE = sql`a.is_sealed_bid = true
  AND a.is_active = true
  AND a.status IN ('published', 'closed')`;

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function assertSealedBidAuction(
  clientId: number,
  auctionId: number,
): Promise<void> {
  const res = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM auctions a
      WHERE a.auction_id = ${auctionId}
        AND a.client_id = ${clientId}
        AND ${SEALED_AUCTION_SCOPE}
    ) AS ok
  `);
  if (res.rows[0]?.ok !== true) {
    throw new AdminReportsNotFoundError(AdminReportsMessages.AUCTION_NOT_FOUND);
  }
}

class SealedBidReportService {
  /** Sealed-bid auctions whose sealed-bid date falls in the range. */
  async listAuctions(
    clientId: number,
    range: { from: string; to: string },
  ): Promise<AdminReportAuctionOption[]> {
    const res = await db.execute<{
      auction_id: number;
      auction_number: string | null;
      auction_date: string | null;
    }>(sql`
      SELECT a.auction_id, a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date
      FROM auctions a
      WHERE ${SEALED_AUCTION_SCOPE}
        AND a.client_id = ${clientId}
        AND a.sealed_bid_date::date >= CAST(${range.from} AS date)
        AND a.sealed_bid_date::date <= CAST(${range.to} AS date)
      ORDER BY a.sealed_bid_date DESC, a.auction_id DESC
    `);
    return res.rows.map((r) => ({
      auctionId: r.auction_id,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
    }));
  }

  async auctionReportMeta(
    clientId: number,
    auctionId: number,
  ): Promise<AuctionReportMeta> {
    await assertSealedBidAuction(clientId, auctionId);
    return queryAuctionReportMeta(clientId, auctionId);
  }

  /**
   * One row per active lot. Only each bidder's latest sealed-bid counts; the
   * winner follows `SealedBidService.summary()` (best amount for the auction
   * direction, ties to the earliest bid).
   */
  async report(
    clientId: number,
    auctionId: number,
  ): Promise<SealedBidReportRow[]> {
    await assertSealedBidAuction(clientId, auctionId);
    const res = await db.execute<{
      lot_id: number;
      client_id: number;
      client_name: string | null;
      auction_number: string | null;
      auction_date: string | null;
      lot_number: string | null;
      uom: string | null;
      sealed_bid_date: string | null;
      start_time: string | null;
      end_time: string | null;
      min_amount: string | null;
      max_amount: string | null;
      avg_amount: string | null;
      bidder_count: number | null;
      winning_bidder: string | null;
      winning_amount: string | null;
    }>(sql`
      WITH latest AS (
        SELECT DISTINCT ON (sb.lot_id, sb.bidder_id)
          sb.id, sb.lot_id, sb.bidder_id, sb.amount, sb.created_at
        FROM auction_sealed_bids sb
        WHERE sb.auction_id = ${auctionId}
        ORDER BY sb.lot_id, sb.bidder_id, sb.created_at DESC, sb.id DESC
      ),
      stats AS (
        SELECT lt.lot_id,
               min(lt.amount) AS min_amount,
               max(lt.amount) AS max_amount,
               round(avg(lt.amount), 2) AS avg_amount,
               count(*)::int AS bidder_count
        FROM latest lt
        GROUP BY lt.lot_id
      ),
      ranked AS (
        SELECT lt.*, ROW_NUMBER() OVER (
          PARTITION BY lt.lot_id
          ORDER BY
            CASE WHEN a.auction_type = 'reverse' THEN -lt.amount ELSE lt.amount END DESC,
            lt.created_at ASC, lt.id ASC
        ) AS rn
        FROM latest lt
        JOIN auctions a ON a.auction_id = ${auctionId}
      )
      SELECT l.id AS lot_id,
             a.client_id,
             c.company_name AS client_name,
             a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
             l.lot_number,
             u.code AS uom,
             to_char(a.sealed_bid_date, 'YYYY-MM-DD') AS sealed_bid_date,
             to_char(a.sealed_bid_date::date + a.sealed_bid_start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
             to_char(a.sealed_bid_date::date + a.sealed_bid_end_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_time,
             s.min_amount,
             s.max_amount,
             s.avg_amount,
             s.bidder_count,
             b.company_name AS winning_bidder,
             r.amount AS winning_amount
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      JOIN clients c ON c.id = a.client_id
      LEFT JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN stats s ON s.lot_id = l.id
      LEFT JOIN ranked r ON r.lot_id = l.id AND r.rn = 1
      LEFT JOIN bidders b ON b.id = r.bidder_id
      WHERE l.auction_id = ${auctionId}
        AND l.is_active = true
      ORDER BY l.display_order NULLS LAST, l.id
    `);
    return res.rows.map((r) => ({
      lotId: r.lot_id,
      clientId: r.client_id,
      clientName: r.client_name,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
      lotNumber: r.lot_number,
      uom: r.uom,
      sealedBidDate: r.sealed_bid_date,
      startTime: r.start_time,
      endTime: r.end_time,
      minAmount: num(r.min_amount),
      maxAmount: num(r.max_amount),
      avgAmount: num(r.avg_amount),
      bidderCount: r.bidder_count ?? 0,
      winningBidder: r.winning_bidder,
      winningAmount: num(r.winning_amount),
    }));
  }
}

export const sealedBidReportService = new SealedBidReportService();

import { formatDate } from "@auctionit/lib/date";
import { columnRangeFrom, ignoreNumberStoredAsText } from "@auctionit/xlsx-export";
import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { EMD_REFUND_OPEN_STATUSES } from "../db/schema/index.js";
import { round2, sqlInList, toAmount } from "../lib/emd/constants.js";
import { clampPagination } from "./list-query.js";
import { emdBlocksService } from "./emd-blocks.service.js";

/**
 * Bidder-wise EMD report (legacy buyerWiseReport). Balances come from the
 * bidder caches, which the ledger writer keeps in step; "Refund pending" is
 * money already debited for open refund requests and still held by iCom.
 */
export type BidderEmdReportRow = {
  bidderId: number;
  companyName: string;
  van: string | null;
  available: number;
  blocked: number;
  refundPending: number;
  total: number;
};

export type BidderEmdReportSummary = {
  available: number;
  blocked: number;
  refundPending: number;
  total: number;
};

/**
 * `q` matches bidder name or id; empty → every bidder with EMD activity.
 * `heldOnly` keeps bidders with EMD held for won lots, pending lifting (EMD
 * Release page).
 */
export type BidderEmdReportFilters = { q?: string; heldOnly?: boolean };

export type BidderEmdReportPage = {
  items: BidderEmdReportRow[];
  total: number;
  page: number;
  pageSize: number;
};

type RawRow = {
  bidder_id: number;
  company_name: string;
  van: string | null;
  available: string;
  blocked: string;
  refund_pending: string;
};

function toRow(r: RawRow): BidderEmdReportRow {
  const available = toAmount(r.available);
  const blocked = toAmount(r.blocked);
  const refundPending = toAmount(r.refund_pending);
  return {
    bidderId: r.bidder_id,
    companyName: r.company_name,
    van: r.van,
    available,
    blocked,
    refundPending,
    total: round2(available + blocked + refundPending),
  };
}

export class EmdReportsService {
  private baseQuery(f: BidderEmdReportFilters) {
    const q = f.q?.trim();
    const bidderFilter = q
      ? sql`AND (b.company_name ILIKE ${`%${q}%`} OR b.id::text ILIKE ${`%${q}%`})`
      : sql``;
    const heldFilter = f.heldOnly
      ? sql`AND EXISTS (
          SELECT 1 FROM emd_range_holds h
          WHERE h.bidder_id = b.id AND h.amount_held - h.amount_released - h.amount_forfeited > 0
        )`
      : sql``;
    return sql`
      SELECT b.id AS bidder_id, b.company_name, b.van,
             b.emd_available_balance AS available,
             b.emd_blocked_balance AS blocked,
             COALESCE(rp.amount, 0) AS refund_pending
      FROM bidders b
      LEFT JOIN (
        SELECT bidder_id, SUM(amount) AS amount FROM emd_refunds
        WHERE status IN (${sql.raw(sqlInList(EMD_REFUND_OPEN_STATUSES))})
        GROUP BY bidder_id
      ) rp ON rp.bidder_id = b.id
      WHERE EXISTS (SELECT 1 FROM emd_transactions t WHERE t.bidder_id = b.id)
      ${bidderFilter}
      ${heldFilter}
    `;
  }

  async bidderCount(filters: BidderEmdReportFilters): Promise<number> {
    const res = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM (${this.baseQuery(filters)}) r`,
    );
    return res.rows[0]?.n ?? 0;
  }

  async bidderWise(
    opts: BidderEmdReportFilters & { page: number; pageSize: number },
  ): Promise<BidderEmdReportPage> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const base = this.baseQuery(opts);
    const [countRes, rowsRes] = await Promise.all([
      db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM (${base}) r`),
      db.execute<RawRow>(sql`
        ${base}
        ORDER BY b.company_name ASC, b.id ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
    ]);
    return {
      items: rowsRes.rows.map(toRow),
      total: countRes.rows[0]?.n ?? 0,
      page,
      pageSize,
    };
  }

  async bidderWiseSummary(filters: BidderEmdReportFilters): Promise<BidderEmdReportSummary> {
    const res = await db.execute<{
      available: string;
      blocked: string;
      refund_pending: string;
    }>(sql`
      SELECT COALESCE(SUM(r.available), 0) AS available,
             COALESCE(SUM(r.blocked), 0) AS blocked,
             COALESCE(SUM(r.refund_pending), 0) AS refund_pending
      FROM (${this.baseQuery(filters)}) r
    `);
    const row = res.rows[0];
    const available = toAmount(row?.available);
    const blocked = toAmount(row?.blocked);
    const refundPending = toAmount(row?.refund_pending);
    return {
      available,
      blocked,
      refundPending,
      total: round2(available + blocked + refundPending),
    };
  }

  async bidderWiseXlsx(filters: BidderEmdReportFilters): Promise<Buffer> {
    const res = await db.execute<RawRow>(sql`
      ${this.baseQuery(filters)}
      ORDER BY b.company_name ASC, b.id ASC
    `);
    const bidderRows = res.rows.map(toRow);
    const companyNameByBidderId = new Map(bidderRows.map((r) => [r.bidderId, r.companyName]));
    const blockedRows = await emdBlocksService.blockedBreakdown(bidderRows.map((r) => r.bidderId));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "AuctionIT Admin";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("EMD Report", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = [
      { header: "Bidder Id", key: "bidderId", width: 12 },
      { header: "VAN", key: "van", width: 16 },
      { header: "Company Name", key: "companyName", width: 40 },
      { header: "Withdrawable", key: "available", width: 16 },
      { header: "Blocked", key: "blocked", width: 16 },
      { header: "Refund in Process", key: "refundPending", width: 18 },
      { header: "Total EMD", key: "total", width: 16 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const r of bidderRows) {
      sheet.addRow({ ...r, van: r.van ?? "" });
    }

    const blockedSheet = workbook.addWorksheet("EMD Blocked", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    blockedSheet.columns = [
      { header: "Auction No.", key: "auctionNumber", width: 16 },
      { header: "Auction Date", key: "auctionDate", width: 14 },
      { header: "Bidder Name", key: "bidderName", width: 40 },
      { header: "Bidder Id", key: "bidderId", width: 12 },
      { header: "Lot(s)", key: "lots", width: 24 },
      { header: "Blocked", key: "blocked", width: 16 },
    ];
    blockedSheet.getRow(1).font = { bold: true };
    for (const r of blockedRows) {
      blockedSheet.addRow({
        auctionNumber: r.auctionNumber ?? "",
        auctionDate: formatDate(r.auctionDate),
        bidderName: companyNameByBidderId.get(r.bidderId) ?? "",
        bidderId: r.bidderId,
        lots: r.lots.join(", "),
        blocked: r.blocked,
      });
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return ignoreNumberStoredAsText(buffer, {
      [blockedSheet.name]: [columnRangeFrom(1, 2)],
    });
  }
}

export const emdReportsService = new EmdReportsService();

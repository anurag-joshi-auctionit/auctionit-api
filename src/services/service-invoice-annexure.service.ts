import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { auctionLots } from "../db/schema/auction-lots.js";
import { auctions } from "../db/schema/auctions.js";
import { bidders } from "../db/schema/bidders.js";
import { liftingClientLogs } from "../db/schema/lifting-client-log.js";
import { uoms } from "../db/schema/uoms.js";
import { parseServiceInvoiceAnnexureBuffer } from "../lib/service-invoices/annexure-parse.js";
import { aggregateAnnexureTotals } from "../lib/service-invoices/annexure-totals.js";
import { WINNER_LABEL } from "@auctionit/lib/winner-rank";
import type {
  ServiceInvoiceAnnexureLine,
  ServiceInvoiceAnnexureParseResult,
  ServiceInvoiceAnnexureResult,
} from "../lib/service-invoices/annexure-types.js";

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function toDateOnly(value: string | Date | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (Number.isNaN(value.getTime())) return "";
  // Local YMD — node-pg returns timestamp-without-tz as local Date; UTC ISO can shift the day.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export type FetchAutoAnnexureParams = {
  clientId: number;
  plantLocationId: number;
  fromDate: string | Date;
  toDate: string | Date;
};

/**
 * Auto annexure: FROM lifting_client_logs, period on lifting_date,
 * one row per lot with SUM(qty), enriched via FKs.
 */
export async function fetchAutoAnnexureLines(
  params: FetchAutoAnnexureParams,
): Promise<ServiceInvoiceAnnexureResult> {
  const from = toDateOnly(params.fromDate);
  const to = toDateOnly(params.toDate);

  // Prefer product from log item_id; fall back to first active auction_lot_items row.
  const productSql = sql<string>`COALESCE(
    (
      SELECT COALESCE(
        NULLIF(TRIM(i2.name), ''),
        NULLIF(TRIM(m2.label), ''),
        ''
      )
      FROM lifting_client_logs ll2
      INNER JOIN items i2 ON i2.id = ll2.item_id
      LEFT JOIN materials m2 ON m2.id = i2.material_id
      WHERE ll2.lot_id = ${auctionLots.id}
        AND ll2.client_id = ${params.clientId}
        AND ll2.item_id IS NOT NULL
        AND ll2.lifting_date >= ${from}
        AND ll2.lifting_date <= ${to}
      ORDER BY ll2.id DESC
      LIMIT 1
    ),
    (
      SELECT COALESCE(
        NULLIF(TRIM(ali.material_name), ''),
        NULLIF(TRIM(i.name), ''),
        NULLIF(TRIM(m.label), ''),
        ''
      )
      FROM auction_lot_items ali
      LEFT JOIN items i ON i.id = ali.item_id
      LEFT JOIN materials m ON m.id = i.material_id
      WHERE ali.lot_id = ${auctionLots.id}
        AND ali.is_active = true
      ORDER BY ali.id
      LIMIT 1
    ),
    ''
  )`;

  const rows = await db
    .select({
      lotId: auctionLots.id,
      auctionNumber: auctions.auctionNumber,
      auctionDate: auctions.auctionDate,
      auctionType: auctions.auctionType,
      lotNumber: auctionLots.lotNumber,
      approvedQty: auctionLots.quantity,
      winningPrice: auctionLots.winningAmount,
      uomCode: uoms.code,
      bidderName: bidders.companyName,
      liftedQty: sql<string>`SUM(CAST(${liftingClientLogs.qty} AS decimal(38, 3)))`,
      product: productSql,
    })
    .from(liftingClientLogs)
    .innerJoin(auctionLots, eq(auctionLots.id, liftingClientLogs.lotId))
    .innerJoin(
      auctions,
      and(
        eq(auctions.id, liftingClientLogs.auctionId),
        eq(auctions.clientId, liftingClientLogs.clientId),
      ),
    )
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .leftJoin(bidders, eq(bidders.id, auctionLots.winnerBidderId))
    .where(
      and(
        eq(liftingClientLogs.clientId, params.clientId),
        eq(auctionLots.plantLocationId, params.plantLocationId),
        eq(auctionLots.isApproved, true),
        // Invoice period: inclusive on lifting_date (not auctionDate).
        gte(liftingClientLogs.liftingDate, from),
        lte(liftingClientLogs.liftingDate, to),
      ),
    )
    .groupBy(
      auctionLots.id,
      auctions.auctionNumber,
      auctions.auctionDate,
      auctions.auctionType,
      auctionLots.lotNumber,
      auctionLots.quantity,
      auctionLots.winningAmount,
      uoms.code,
      bidders.companyName,
    )
    .having(
      sql`SUM(CAST(${liftingClientLogs.qty} AS decimal(38, 3))) > 0`,
    );

  const lines: ServiceInvoiceAnnexureLine[] = [];
  for (const r of rows) {
    const liftedQty = round3(num(r.liftedQty));
    if (liftedQty <= 0) continue;
    // Skip lots with no winning price (cannot compute amount reliably).
    if (r.winningPrice == null || r.winningPrice === "") continue;
    const winningPrice = num(r.winningPrice);
    const amount = round3(winningPrice * liftedQty);

    lines.push({
      lineOrder: lines.length + 1,
      auctionNumber: r.auctionNumber?.trim() || `Auction ${r.lotId}`,
      auctionDate: toDateOnly(r.auctionDate),
      lotNumber: r.lotNumber?.trim() || String(r.lotId),
      product: r.product?.trim() || "",
      approvedQty: round3(num(r.approvedQty)),
      uom: r.uomCode?.trim() || "",
      rankLabel: WINNER_LABEL,
      winningPrice,
      bidderName: r.bidderName?.trim() || "",
      liftedQty,
      amount,
    });
  }

  lines.sort((a, b) => {
    const d = a.auctionDate.localeCompare(b.auctionDate);
    if (d !== 0) return d;
    return a.lotNumber.localeCompare(b.lotNumber);
  });
  lines.forEach((line, i) => {
    line.lineOrder = i + 1;
  });

  return {
    lines,
    totals: aggregateAnnexureTotals(lines),
  };
}

export async function parseManualAnnexure(
  buffer: Buffer,
): Promise<ServiceInvoiceAnnexureParseResult> {
  return parseServiceInvoiceAnnexureBuffer(buffer);
}

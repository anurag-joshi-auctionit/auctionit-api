import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  AUCTION_DAY,
  LOT_SCOPE,
  dateParams,
  num,
  numOrNull,
  round,
  type ReportDateRange,
} from "./report-sql.js";
import {
  fetchLiftingDetails,
  type LiftingDetailRow,
} from "./lifting-report.service.js";

export type RevenueReportParams = ReportDateRange;

export type RevenueSummaryRow = {
  clientId: number;
  clientName: string;
  auctionedValuePeriod: number;
  approvedValuePeriod: number;
  liftedValuePeriod: number;
  auctionedValueItd: number;
  approvedValueItd: number;
  liftedValueItd: number;
  totalRevenue: number;
};

export type RevenueDetailRow = {
  clientName: string;
  auctionNumber: string | null;
  auctionDate: string | null;
  lotNumber: string | null;
  plantLocation: string | null;
  winningBidder: string | null;
  winningPrice: number | null;
  unit: string | null;
  auctionedQty: number;
  approvedQty: number;
  liftedQty: number;
  balanceQty: number;
  auctionedValue: number | null;
  approvedValue: number | null;
  liftedValue: number | null;
  liftingStatus: string | null;
  liftingPeriod: number | null;
  liftingDueDate: string | null;
  lastLiftingDate: string | null;
  liftingDelayDays: number | null;
  benchmarkPrice: number | null;
  benchmarkMaterial: string | null;
  benchmarkLocation: string | null;
  reviewStatus: string;
  /** IST wall-clock `YYYY-MM-DDTHH:MM:SS`. */
  reviewedAt: string | null;
  reviewedBy: string | null;
  attachedBidders: number;
  loggedInBidders: number;
  participatedBidders: number;
  startBidPrice: number | null;
};

export type RevenueReportData = {
  summary: RevenueSummaryRow[];
  details: RevenueDetailRow[];
  lifting: LiftingDetailRow[];
};

export type RevenueReportStage = "summary" | "details" | "lifting";

const OPEN_LIFTING_STATUS_ID = 1;
const OPEN_LIFTING_STATUS_LABEL = "Open";
const REVIEW_STATUS_APPROVED = "Approved";
const REVIEW_STATUS_REJECTED = "Rejected";
const REVIEW_STATUS_PENDING = "Pending";

function utcDay(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(utcDay(isoDate));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((utcDay(toIso) - utcDay(fromIso)) / 86_400_000);
}

type SummarySqlRow = {
  client_id: number;
  client_name: string;
  auctioned_period: string | null;
  approved_period: string | null;
  lifted_period: string | null;
  auctioned_itd: string | null;
  approved_itd: string | null;
  lifted_itd: string | null;
  total_revenue: string | null;
};

/**
 * Period and ITD (up to To) values per client, plus the service fee estimate
 * from client config applied to lifting dated within the period.
 */
async function fetchSummary(
  params: RevenueReportParams,
): Promise<RevenueSummaryRow[]> {
  const { from, to } = dateParams(params);
  const res = await db.execute<SummarySqlRow>(sql`
    WITH lots_base AS (
      SELECT l.id AS lot_id,
             l.client_id,
             l.plant_location_id,
             l.quantity,
             l.is_approved,
             l.winning_amount,
             ${AUCTION_DAY} AS auction_day
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      WHERE ${LOT_SCOPE}
    ),
    lot_vals AS (
      SELECT client_id,
             SUM(quantity * winning_amount) FILTER (
               WHERE auction_day >= ${from}
             ) AS auctioned_period,
             SUM(quantity * winning_amount) FILTER (
               WHERE auction_day >= ${from} AND is_approved = true
             ) AS approved_period,
             SUM(quantity * winning_amount) AS auctioned_itd,
             SUM(quantity * winning_amount) FILTER (
               WHERE is_approved = true
             ) AS approved_itd
      FROM lots_base
      WHERE auction_day <= ${to}
      GROUP BY client_id
    ),
    lift_vals AS (
      SELECT lb.client_id,
             SUM(ll.qty * lb.winning_amount) FILTER (
               WHERE ll.lifting_date >= ${from}
             ) AS lifted_period,
             SUM(ll.qty * lb.winning_amount) AS lifted_itd,
             SUM(ll.qty) FILTER (
               WHERE ll.lifting_date >= ${from}
             ) AS lifted_qty_period,
             COUNT(DISTINCT (lb.plant_location_id, date_trunc('month', ll.lifting_date))) FILTER (
               WHERE ll.lifting_date >= ${from} AND ll.qty <> 0
             ) AS plant_months
      FROM lifting_client_logs ll
      JOIN lots_base lb ON lb.lot_id = ll.lot_id
      WHERE ll.lifting_date <= ${to}
      GROUP BY lb.client_id
    )
    SELECT c.id AS client_id,
           c.company_name AS client_name,
           lt.auctioned_period,
           lt.approved_period,
           lv.lifted_period,
           lt.auctioned_itd,
           lt.approved_itd,
           lv.lifted_itd,
           CASE c.service_fee_type
             WHEN 'service_percentage' THEN
               COALESCE(lv.lifted_period, 0) * c.service_fee_value::numeric / 100
             WHEN 'pmt' THEN
               COALESCE(lv.lifted_qty_period, 0) * c.service_fee_value::numeric
             WHEN 'fixed_amount' THEN
               COALESCE(lv.plant_months, 0) * c.service_fee_value::numeric
             ELSE 0
           END AS total_revenue
    FROM clients c
    LEFT JOIN lot_vals lt ON lt.client_id = c.id
    LEFT JOIN lift_vals lv ON lv.client_id = c.id
    WHERE lt.client_id IS NOT NULL OR lv.client_id IS NOT NULL
  `);

  return res.rows
    .map(
      (r): RevenueSummaryRow => ({
        clientId: r.client_id,
        clientName: r.client_name,
        auctionedValuePeriod: round(num(r.auctioned_period), 2),
        approvedValuePeriod: round(num(r.approved_period), 2),
        liftedValuePeriod: round(num(r.lifted_period), 2),
        auctionedValueItd: round(num(r.auctioned_itd), 2),
        approvedValueItd: round(num(r.approved_itd), 2),
        liftedValueItd: round(num(r.lifted_itd), 2),
        totalRevenue: round(num(r.total_revenue), 2),
      }),
    )
    .filter(
      (r) =>
        r.auctionedValuePeriod !== 0 ||
        r.approvedValuePeriod !== 0 ||
        r.liftedValuePeriod !== 0 ||
        r.auctionedValueItd !== 0 ||
        r.approvedValueItd !== 0 ||
        r.liftedValueItd !== 0,
    )
    .sort((a, b) =>
      a.clientName.localeCompare(b.clientName, undefined, {
        sensitivity: "base",
      }),
    );
}

type DetailSqlRow = {
  client_name: string;
  auction_number: string | null;
  auction_day: string | null;
  lot_number: string | null;
  plant_location: string | null;
  winning_bidder: string | null;
  winning_amount: string | null;
  unit: string | null;
  quantity: string | null;
  is_approved: boolean | null;
  reviewed_at: string | null;
  reviewed_day: string | null;
  reviewed_by: string | null;
  material_lifting_days: number | null;
  lifted_qty: string | null;
  last_lifted_date: string | null;
  lifting_status_id: number | null;
  lifting_status: string | null;
  benchmark_price: string | null;
  benchmark_material: string | null;
  benchmark_location: string | null;
  attached_bidders: number | null;
  logged_in_bidders: number | null;
  participated_bidders: number | null;
  start_bid_price: string | null;
};

function reviewStatus(isApproved: boolean | null): string {
  if (isApproved === true) return REVIEW_STATUS_APPROVED;
  if (isApproved === false) return REVIEW_STATUS_REJECTED;
  return REVIEW_STATUS_PENDING;
}

/** Lots auctioned within the period; lifting aggregated up to To. */
async function fetchDetails(
  params: RevenueReportParams,
): Promise<RevenueDetailRow[]> {
  const { from, to } = dateParams(params);
  const res = await db.execute<DetailSqlRow>(sql`
    WITH scoped AS (
      SELECT l.id AS lot_id,
             l.client_id,
             l.auction_id,
             l.plant_location_id,
             l.quantity,
             l.is_approved,
             l.reviewed_at,
             l.reviewed_by,
             l.uom_id,
             l.winning_amount,
             l.winner_bidder_id,
             l.material_lifting_days,
             l.start_bid_price,
             l.lot_number,
             l.display_order,
             l.bidder_count,
             a.auction_number,
             ${AUCTION_DAY} AS auction_day
      FROM auction_lots l
      JOIN auctions a ON a.auction_id = l.auction_id
      WHERE ${LOT_SCOPE}
        AND ${AUCTION_DAY} BETWEEN ${from} AND ${to}
    ),
    lift AS (
      SELECT ll.lot_id,
             SUM(ll.qty) AS lifted_qty,
             MAX(ll.lifting_date) AS last_lifted_date
      FROM lifting_client_logs ll
      JOIN scoped s ON s.lot_id = ll.lot_id
      WHERE ll.lifting_date <= ${to}
      GROUP BY ll.lot_id
    ),
    latest_status AS (
      SELECT DISTINCT ON (ll.lot_id) ll.lot_id, ll.lifting_status
      FROM lifting_client_logs ll
      JOIN scoped s ON s.lot_id = ll.lot_id
      WHERE ll.lifting_date <= ${to}
      ORDER BY ll.lot_id, ll.lifting_date DESC, ll.id DESC
    ),
    first_item AS (
      SELECT DISTINCT ON (ali.lot_id)
             ali.lot_id,
             ali.benchmark_material_location_id
      FROM auction_lot_items ali
      JOIN scoped s ON s.lot_id = ali.lot_id
      WHERE ali.is_active = true
      ORDER BY ali.lot_id, ali.id
    ),
    attached AS (
      SELECT m.lot_id,
             COUNT(DISTINCT m.bidder_id)::int AS attached_bidders,
             COUNT(DISTINCT m.bidder_id) FILTER (
               WHERE EXISTS (
                 SELECT 1
                 FROM auction_tnc_acceptances t
                 WHERE t.auction_id = m.auction_id
                   AND t.bidder_id = m.bidder_id
               )
             )::int AS logged_in_bidders
      FROM auction_lot_bidder_maps m
      JOIN scoped s ON s.lot_id = m.lot_id
      WHERE m.is_active = true
      GROUP BY m.lot_id
    ),
    participated AS (
      SELECT b.lot_id, COUNT(DISTINCT b.bidder_id)::int AS participated_bidders
      FROM auction_bids b
      JOIN scoped s ON s.lot_id = b.lot_id
      GROUP BY b.lot_id
    )
    SELECT c.company_name AS client_name,
           s.auction_number,
           to_char(s.auction_day, 'YYYY-MM-DD') AS auction_day,
           s.lot_number,
           pl.name AS plant_location,
           bd.company_name AS winning_bidder,
           s.winning_amount,
           uo.code AS unit,
           s.quantity,
           s.is_approved,
           to_char(s.reviewed_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') AS reviewed_at,
           to_char(s.reviewed_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS reviewed_day,
           u.name AS reviewed_by,
           s.material_lifting_days,
           lf.lifted_qty,
           to_char(lf.last_lifted_date, 'YYYY-MM-DD') AS last_lifted_date,
           ls.lifting_status AS lifting_status_id,
           disp.label AS lifting_status,
           bp.price_inr AS benchmark_price,
           bml.material AS benchmark_material,
           bml.location AS benchmark_location,
           att.attached_bidders,
           att.logged_in_bidders,
           COALESCE(pt.participated_bidders, s.bidder_count) AS participated_bidders,
           s.start_bid_price
    FROM scoped s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN plant_locations pl ON pl.id = s.plant_location_id
    LEFT JOIN uoms uo ON uo.id = s.uom_id
    LEFT JOIN bidders bd ON bd.id = s.winner_bidder_id
    LEFT JOIN users u ON u.id = s.reviewed_by
    LEFT JOIN lift lf ON lf.lot_id = s.lot_id
    LEFT JOIN latest_status ls ON ls.lot_id = s.lot_id
    LEFT JOIN lifting_client_dispositions disp ON disp.id = ls.lifting_status
    LEFT JOIN first_item fi ON fi.lot_id = s.lot_id
    LEFT JOIN benchmark_material_locations bml
      ON bml.id = fi.benchmark_material_location_id
    LEFT JOIN LATERAL (
      SELECT p.price_inr
      FROM benchmark_prices p
      WHERE p.benchmark_material_location_id = fi.benchmark_material_location_id
        AND p.benchmark_date <= s.auction_day
      ORDER BY p.benchmark_date DESC
      LIMIT 1
    ) bp ON true
    LEFT JOIN attached att ON att.lot_id = s.lot_id
    LEFT JOIN participated pt ON pt.lot_id = s.lot_id
    ORDER BY lower(c.company_name),
             s.auction_day,
             s.auction_number,
             s.display_order NULLS LAST,
             s.lot_id
  `);

  return res.rows.map((r): RevenueDetailRow => {
    const approved = r.is_approved === true;
    const auctionedQty = round(num(r.quantity), 3);
    const approvedQty = approved ? auctionedQty : 0;
    const liftedQty = round(num(r.lifted_qty), 3);
    const price = numOrNull(r.winning_amount);
    const value = (qty: number) => (price == null ? null : round(qty * price, 2));
    const liftingPeriod = r.material_lifting_days;
    const liftingDueDate =
      approved && r.reviewed_day && liftingPeriod != null
        ? addDays(r.reviewed_day, liftingPeriod)
        : null;
    const isOpen =
      r.lifting_status_id == null ||
      r.lifting_status_id === OPEN_LIFTING_STATUS_ID;
    const delayEnd = isOpen ? params.to : (r.last_lifted_date ?? params.to);
    const liftingDelayDays =
      liftingDueDate == null
        ? null
        : Math.max(0, daysBetween(liftingDueDate, delayEnd));

    return {
      clientName: r.client_name,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_day,
      lotNumber: r.lot_number,
      plantLocation: r.plant_location,
      winningBidder: r.winning_bidder,
      winningPrice: price,
      unit: r.unit,
      auctionedQty,
      approvedQty,
      liftedQty,
      balanceQty: round(approvedQty - liftedQty, 3),
      auctionedValue: value(auctionedQty),
      approvedValue: value(approvedQty),
      liftedValue: value(liftedQty),
      liftingStatus: approved
        ? (r.lifting_status ?? OPEN_LIFTING_STATUS_LABEL)
        : null,
      liftingPeriod,
      liftingDueDate,
      lastLiftingDate: r.last_lifted_date,
      liftingDelayDays,
      benchmarkPrice: numOrNull(r.benchmark_price),
      benchmarkMaterial: r.benchmark_material,
      benchmarkLocation: r.benchmark_location,
      reviewStatus: reviewStatus(r.is_approved),
      reviewedAt: r.reviewed_at,
      reviewedBy: r.reviewed_by,
      attachedBidders: r.attached_bidders ?? 0,
      loggedInBidders: r.logged_in_bidders ?? 0,
      participatedBidders: r.participated_bidders ?? 0,
      startBidPrice: numOrNull(r.start_bid_price),
    };
  });
}

export type RevenueSummaryTotals = Omit<
  RevenueSummaryRow,
  "clientId" | "clientName"
>;

export type RevenueSummaryPage = {
  items: RevenueSummaryRow[];
  total: number;
  /** Sums over every client in range, not just this page. */
  totals: RevenueSummaryTotals;
  page: number;
  pageSize: number;
};

function sumSummary(rows: RevenueSummaryRow[]): RevenueSummaryTotals {
  const totals: RevenueSummaryTotals = {
    auctionedValuePeriod: 0,
    approvedValuePeriod: 0,
    liftedValuePeriod: 0,
    auctionedValueItd: 0,
    approvedValueItd: 0,
    liftedValueItd: 0,
    totalRevenue: 0,
  };
  const keys = Object.keys(totals) as (keyof RevenueSummaryTotals)[];
  for (const row of rows) {
    for (const key of keys) totals[key] += row[key];
  }
  return totals;
}

export const revenueReportService = {
  async summaryPage(
    params: RevenueReportParams & { page: number; pageSize: number },
  ): Promise<RevenueSummaryPage> {
    const rows = await fetchSummary(params);
    const start = (params.page - 1) * params.pageSize;
    return {
      items: rows.slice(start, start + params.pageSize),
      total: rows.length,
      totals: sumSummary(rows),
      page: params.page,
      pageSize: params.pageSize,
    };
  },

  async build(
    params: RevenueReportParams,
    onStage?: (stage: RevenueReportStage) => void,
  ): Promise<RevenueReportData> {
    onStage?.("summary");
    const summary = await fetchSummary(params);
    onStage?.("details");
    const details = await fetchDetails(params);
    onStage?.("lifting");
    const lifting = await fetchLiftingDetails(params);
    return { summary, details, lifting };
  },
};

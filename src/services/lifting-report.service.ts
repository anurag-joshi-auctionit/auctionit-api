import { sql, type SQL } from "drizzle-orm";
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

export type LiftingReportParams = ReportDateRange & {
  /** Empty / omitted → every client. */
  clientIds?: number[];
};

/** One lot with at least one lifting entry dated within the period. */
export type LiftingOverviewRow = {
  lotId: number;
  clientName: string;
  auctionNumber: string | null;
  auctionDate: string | null;
  lotNumber: string | null;
  winningBidder: string | null;
  winningPrice: number | null;
  unit: string | null;
  approvedQty: number;
  liftedBeforePeriodQty: number;
  liftedBeforePeriodValue: number | null;
  liftedPeriodQty: number;
  liftedPeriodValue: number | null;
  /** Approved minus everything lifted up to To. */
  balanceQty: number;
  lastLiftedDate: string | null;
  status: string | null;
};

export type LiftingDetailRow = {
  /** First day of the lifting month, `YYYY-MM-DD`. */
  liftingMonth: string;
  clientName: string;
  auctionNumber: string | null;
  auctionDate: string | null;
  lotNumber: string | null;
  winningBidder: string | null;
  winningPrice: number | null;
  unit: string | null;
  approvedQty: number;
  /** Lifted on the lot before From; same on every row of the lot. */
  liftedBeforePeriodQty: number;
  liftedBeforePeriodValue: number | null;
  /** This entry's quantity. */
  liftedPeriodQty: number;
  liftedPeriodValue: number | null;
  liftedDate: string;
  /** Running balance over all of the lot's entries up to this one. */
  balanceQty: number;
  status: string | null;
};

export type LiftingOverviewStats = {
  approvedQty: number;
  liftedPeriodQty: number;
  balanceQty: number;
  liftedPeriodValue: number;
};

export type LiftingOverviewPage = {
  items: LiftingOverviewRow[];
  total: number;
  /** Over every lot in range, not just this page. */
  stats: LiftingOverviewStats;
  page: number;
  pageSize: number;
};

export type LiftingReportData = {
  overview: LiftingOverviewRow[];
  detail: LiftingDetailRow[];
};

export type LiftingReportStage = "overview" | "detail";

function valueOf(qty: number, price: number | null): number | null {
  return price == null ? null : round(qty * price, 2);
}

/** Lots with a lifting entry dated From–To, optionally limited to the given clients. */
function periodLotsCte(params: LiftingReportParams): SQL {
  const { from, to } = dateParams(params);
  const clientFilter = params.clientIds?.length
    ? sql`AND l.client_id IN (${sql.join(
        params.clientIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  return sql`
    period_lots AS (
      SELECT DISTINCT ll.lot_id
      FROM lifting_client_logs ll
      JOIN auction_lots l ON l.id = ll.lot_id
      JOIN auctions a ON a.auction_id = l.auction_id
      WHERE ${LOT_SCOPE}
        AND ll.lifting_date BETWEEN ${from} AND ${to}
        ${clientFilter}
    )`;
}

/** Per-lot lifting totals up to To, split at From. */
function lotAggCtes(params: LiftingReportParams): SQL {
  const { from, to } = dateParams(params);
  return sql`
    WITH ${periodLotsCte(params)},
    lot_agg AS (
      SELECT ll.lot_id,
             COALESCE(SUM(ll.qty) FILTER (WHERE ll.lifting_date < ${from}), 0) AS lifted_before,
             COALESCE(SUM(ll.qty) FILTER (WHERE ll.lifting_date >= ${from}), 0) AS lifted_period,
             COALESCE(SUM(ll.qty), 0) AS lifted_to_date,
             MAX(ll.lifting_date) AS last_lifting_date
      FROM lifting_client_logs ll
      JOIN period_lots p ON p.lot_id = ll.lot_id
      WHERE ll.lifting_date <= ${to}
      GROUP BY ll.lot_id
    )`;
}

type OverviewSqlRow = {
  lot_id: number;
  client_name: string;
  auction_number: string | null;
  auction_day: string | null;
  lot_number: string | null;
  winning_bidder: string | null;
  winning_amount: string | null;
  unit: string | null;
  quantity: string | null;
  is_approved: boolean | null;
  lifted_before: string | null;
  lifted_period: string | null;
  lifted_to_date: string | null;
  last_lifting_date: string | null;
  status: string | null;
};

async function fetchOverview(
  params: LiftingReportParams,
  paging?: { limit: number; offset: number },
): Promise<LiftingOverviewRow[]> {
  const { to } = dateParams(params);
  const page = paging
    ? sql`LIMIT ${paging.limit} OFFSET ${paging.offset}`
    : sql``;
  const res = await db.execute<OverviewSqlRow>(sql`
    ${lotAggCtes(params)},
    latest AS (
      SELECT DISTINCT ON (ll.lot_id) ll.lot_id, ll.lifting_status
      FROM lifting_client_logs ll
      JOIN lot_agg g ON g.lot_id = ll.lot_id
      WHERE ll.lifting_date <= ${to}
      ORDER BY ll.lot_id, ll.lifting_date DESC, ll.id DESC
    )
    SELECT l.id AS lot_id,
           c.company_name AS client_name,
           a.auction_number,
           to_char(${AUCTION_DAY}, 'YYYY-MM-DD') AS auction_day,
           l.lot_number,
           bd.company_name AS winning_bidder,
           l.winning_amount,
           uo.code AS unit,
           l.quantity,
           l.is_approved,
           g.lifted_before,
           g.lifted_period,
           g.lifted_to_date,
           to_char(g.last_lifting_date, 'YYYY-MM-DD') AS last_lifting_date,
           disp.label AS status
    FROM lot_agg g
    JOIN auction_lots l ON l.id = g.lot_id
    JOIN auctions a ON a.auction_id = l.auction_id
    JOIN clients c ON c.id = l.client_id
    LEFT JOIN bidders bd ON bd.id = l.winner_bidder_id
    LEFT JOIN uoms uo ON uo.id = l.uom_id
    LEFT JOIN latest lt ON lt.lot_id = g.lot_id
    LEFT JOIN lifting_client_dispositions disp ON disp.id = lt.lifting_status
    ORDER BY lower(c.company_name),
             ${AUCTION_DAY},
             a.auction_number,
             l.display_order NULLS LAST,
             l.id
    ${page}
  `);

  return res.rows.map((r): LiftingOverviewRow => {
    const approvedQty = r.is_approved === true ? round(num(r.quantity), 3) : 0;
    const liftedBeforePeriodQty = round(num(r.lifted_before), 3);
    const liftedPeriodQty = round(num(r.lifted_period), 3);
    const price = numOrNull(r.winning_amount);
    return {
      lotId: r.lot_id,
      clientName: r.client_name,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_day,
      lotNumber: r.lot_number,
      winningBidder: r.winning_bidder,
      winningPrice: price,
      unit: r.unit,
      approvedQty,
      liftedBeforePeriodQty,
      liftedBeforePeriodValue: valueOf(liftedBeforePeriodQty, price),
      liftedPeriodQty,
      liftedPeriodValue: valueOf(liftedPeriodQty, price),
      balanceQty: round(approvedQty - num(r.lifted_to_date), 3),
      lastLiftedDate: r.last_lifting_date,
      status: r.status,
    };
  });
}

type StatsSqlRow = {
  lots: string | number;
  approved_qty: string | null;
  lifted_period_qty: string | null;
  balance_qty: string | null;
  lifted_period_value: string | null;
};

async function fetchOverviewStats(
  params: LiftingReportParams,
): Promise<{ total: number; stats: LiftingOverviewStats }> {
  const res = await db.execute<StatsSqlRow>(sql`
    ${lotAggCtes(params)}
    SELECT count(*) AS lots,
           SUM(CASE WHEN l.is_approved THEN ROUND(COALESCE(l.quantity, 0)::numeric, 3) ELSE 0 END) AS approved_qty,
           SUM(ROUND(g.lifted_period::numeric, 3)) AS lifted_period_qty,
           SUM(ROUND(CASE WHEN l.is_approved THEN ROUND(COALESCE(l.quantity, 0)::numeric, 3) ELSE 0 END - g.lifted_to_date::numeric, 3)) AS balance_qty,
           SUM(ROUND(ROUND(g.lifted_period::numeric, 3) * l.winning_amount::numeric, 2)) AS lifted_period_value
    FROM lot_agg g
    JOIN auction_lots l ON l.id = g.lot_id
  `);
  const r = res.rows[0];
  return {
    total: Number(r?.lots ?? 0),
    stats: {
      approvedQty: round(num(r?.approved_qty), 3),
      liftedPeriodQty: round(num(r?.lifted_period_qty), 3),
      balanceQty: round(num(r?.balance_qty), 3),
      liftedPeriodValue: round(num(r?.lifted_period_value), 2),
    },
  };
}

type DetailSqlRow = {
  lifting_month: string;
  client_name: string;
  auction_number: string | null;
  auction_day: string | null;
  lot_number: string | null;
  winning_bidder: string | null;
  winning_amount: string | null;
  unit: string | null;
  quantity: string | null;
  is_approved: boolean | null;
  qty: string;
  lifting_date: string;
  lifted_running: string | null;
  lifted_before: string | null;
  status: string | null;
};

/**
 * Every lifting log dated within the period. The running balance is taken
 * over all of the lot's logs (including those before From).
 */
export async function fetchLiftingDetails(
  params: LiftingReportParams,
): Promise<LiftingDetailRow[]> {
  const { from, to } = dateParams(params);
  const res = await db.execute<DetailSqlRow>(sql`
    WITH ${periodLotsCte(params)},
    lot_logs AS (
      SELECT ll.id,
             ll.lot_id,
             ll.qty,
             ll.lifting_date,
             ll.lifting_status,
             SUM(ll.qty) OVER (
               PARTITION BY ll.lot_id
               ORDER BY ll.lifting_date, ll.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS lifted_running,
             SUM(ll.qty) FILTER (WHERE ll.lifting_date < ${from})
               OVER (PARTITION BY ll.lot_id) AS lifted_before
      FROM lifting_client_logs ll
      JOIN period_lots p ON p.lot_id = ll.lot_id
      WHERE ll.lifting_date <= ${to}
    )
    SELECT to_char(date_trunc('month', lg.lifting_date), 'YYYY-MM-DD') AS lifting_month,
           c.company_name AS client_name,
           a.auction_number,
           to_char(${AUCTION_DAY}, 'YYYY-MM-DD') AS auction_day,
           l.lot_number,
           bd.company_name AS winning_bidder,
           l.winning_amount,
           uo.code AS unit,
           l.quantity,
           l.is_approved,
           lg.qty,
           to_char(lg.lifting_date, 'YYYY-MM-DD') AS lifting_date,
           lg.lifted_running,
           lg.lifted_before,
           disp.label AS status
    FROM lot_logs lg
    JOIN auction_lots l ON l.id = lg.lot_id
    JOIN auctions a ON a.auction_id = l.auction_id
    JOIN clients c ON c.id = l.client_id
    LEFT JOIN bidders bd ON bd.id = l.winner_bidder_id
    LEFT JOIN uoms uo ON uo.id = l.uom_id
    LEFT JOIN lifting_client_dispositions disp ON disp.id = lg.lifting_status
    WHERE lg.lifting_date BETWEEN ${from} AND ${to}
    ORDER BY date_trunc('month', lg.lifting_date),
             lower(c.company_name),
             lg.lifting_date,
             a.auction_number,
             l.display_order NULLS LAST,
             l.id,
             lg.id
  `);

  return res.rows.map((r): LiftingDetailRow => {
    const approvedQty = r.is_approved === true ? round(num(r.quantity), 3) : 0;
    const liftedBeforePeriodQty = round(num(r.lifted_before), 3);
    const liftedPeriodQty = round(num(r.qty), 3);
    const price = numOrNull(r.winning_amount);
    return {
      liftingMonth: r.lifting_month,
      clientName: r.client_name,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_day,
      lotNumber: r.lot_number,
      winningBidder: r.winning_bidder,
      winningPrice: price,
      unit: r.unit,
      approvedQty,
      liftedBeforePeriodQty,
      liftedBeforePeriodValue: valueOf(liftedBeforePeriodQty, price),
      liftedPeriodQty,
      liftedPeriodValue: valueOf(liftedPeriodQty, price),
      liftedDate: r.lifting_date,
      balanceQty: round(approvedQty - num(r.lifted_running), 3),
      status: r.status,
    };
  });
}

export const liftingReportService = {
  async overviewPage(
    params: LiftingReportParams & { page: number; pageSize: number },
  ): Promise<LiftingOverviewPage> {
    const [items, { total, stats }] = await Promise.all([
      fetchOverview(params, {
        limit: params.pageSize,
        offset: (params.page - 1) * params.pageSize,
      }),
      fetchOverviewStats(params),
    ]);
    return { items, total, stats, page: params.page, pageSize: params.pageSize };
  },

  async build(
    params: LiftingReportParams,
    onStage?: (stage: LiftingReportStage) => void,
  ): Promise<LiftingReportData> {
    onStage?.("overview");
    const overview = await fetchOverview(params);
    onStage?.("detail");
    const detail = await fetchLiftingDetails(params);
    return { overview, detail };
  },
};

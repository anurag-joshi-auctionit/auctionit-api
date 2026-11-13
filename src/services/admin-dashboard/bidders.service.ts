import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  formatDashboardBucketLabel,
  formatDashboardPeriodLabel,
  resolveMaterialSeriesGrain,
  type IsoDateRange,
} from "../../lib/dashboard/period.js";
import { num, toPeriodIso } from "./helpers.js";

export type BiddersDashboardStats = {
  newBidders: number;
  pendingVerification: number;
  bankUpdatesPending: number;
  participatingBidders: number;
};

export type BiddersSeriesPoint = {
  period: string;
  periodLabel: string;
  count: number;
};

export type TopBidderRow = {
  bidderId: number;
  companyName: string;
  lotsWon: number;
  winValue: number;
};

export type BiddersDashboard = {
  stats: BiddersDashboardStats;
  series: BiddersSeriesPoint[];
  rows: TopBidderRow[];
  currentPeriodLabel: string;
};

type BidderScalars = {
  new_bidders: number;
  pending_verification: number;
  bank_updates_pending: number;
  participating_bidders: number;
};

async function loadScalars(range: IsoDateRange): Promise<BidderScalars> {
  const res = await db.execute<BidderScalars>(sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM bidders b
        WHERE b.created_at::date >= CAST(${range.from} AS date)
          AND b.created_at::date <= CAST(${range.to} AS date)
      ) AS new_bidders,
      (
        SELECT COUNT(*)::int
        FROM bidders b
        WHERE b.is_verified = false
      ) AS pending_verification,
      (
        SELECT COUNT(*)::int
        FROM bidder_bank_accounts ba
        WHERE ba.is_verified = false
      ) AS bank_updates_pending,
      (
        SELECT COUNT(DISTINCT ab.bidder_id)::int
        FROM auction_bids ab
        WHERE ab.created_at::date >= CAST(${range.from} AS date)
          AND ab.created_at::date <= CAST(${range.to} AS date)
      ) AS participating_bidders
  `);
  const row = res.rows[0];
  return {
    new_bidders: num(row?.new_bidders),
    pending_verification: num(row?.pending_verification),
    bank_updates_pending: num(row?.bank_updates_pending),
    participating_bidders: num(row?.participating_bidders),
  };
}

export async function getBidders(
  range: IsoDateRange,
): Promise<BiddersDashboard> {
  const currentPeriodLabel = formatDashboardPeriodLabel(range);
  const grain = resolveMaterialSeriesGrain(range);
  const truncUnit = sql.raw(`'${grain}'`);

  const [current, seriesRes, rowsRes] = await Promise.all([
    loadScalars(range),
    db.execute<{ period: string; count: number }>(sql`
      SELECT
        date_trunc(${truncUnit}, b.created_at)::date::text AS period,
        COUNT(*)::int AS count
      FROM bidders b
      WHERE b.created_at::date >= CAST(${range.from} AS date)
        AND b.created_at::date <= CAST(${range.to} AS date)
      GROUP BY 1
      ORDER BY 1
    `),
    db.execute<{
      bidder_id: number;
      company_name: string;
      lots_won: number;
      win_value: number;
    }>(sql`
      SELECT
        b.id AS bidder_id,
        b.company_name,
        COUNT(l.id)::int AS lots_won,
        COALESCE(SUM(
          CAST(l.winning_amount AS decimal(38, 6))
          * CAST(l.quantity AS decimal(38, 6))
        ), 0) AS win_value
      FROM auction_lots l
      INNER JOIN auctions a ON a.auction_id = l.auction_id
      INNER JOIN bidders b ON b.id = l.winner_bidder_id
      WHERE l.is_active = true
        AND l.winner_bidder_id IS NOT NULL
        AND a.is_active = true
        AND a.auction_date::date >= CAST(${range.from} AS date)
        AND a.auction_date::date <= CAST(${range.to} AS date)
      GROUP BY b.id, b.company_name
      ORDER BY win_value DESC, lots_won DESC
      LIMIT 5
    `),
  ]);

  return {
    stats: {
      newBidders: current.new_bidders,
      pendingVerification: current.pending_verification,
      bankUpdatesPending: current.bank_updates_pending,
      participatingBidders: current.participating_bidders,
    },
    series: seriesRes.rows.map((r) => {
      const period = toPeriodIso(r.period);
      return {
        period,
        periodLabel: formatDashboardBucketLabel(period, grain),
        count: num(r.count),
      };
    }),
    rows: rowsRes.rows.map((r) => ({
      bidderId: num(r.bidder_id),
      companyName: r.company_name,
      lotsWon: num(r.lots_won),
      winValue: num(r.win_value),
    })),
    currentPeriodLabel,
  };
}

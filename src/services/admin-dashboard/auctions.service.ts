import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  formatDashboardBucketLabel,
  formatDashboardPeriodLabel,
  resolveMaterialSeriesGrain,
  type IsoDateRange,
} from "../../lib/dashboard/period.js";
import { num, toPeriodIso } from "./helpers.js";

export type AuctionsDashboardStats = {
  auctionsConducted: number;
  auctionedValue: number;
  liftedValue: number;
  avgBiddersPerLot: number;
  /** Subscription amounts + service invoice amounts in range. */
  totalRevenue: number;
};

export type AuctionsSeriesPoint = {
  period: string;
  periodLabel: string;
  auctions: number;
  auctionedValue: number;
  liftedValue: number;
};

export type AuctionsDashboard = {
  stats: AuctionsDashboardStats;
  series: AuctionsSeriesPoint[];
  currentPeriodLabel: string;
};

type AuctionScalars = {
  auctions_conducted: number;
  auctioned_value: number;
  lifted_value: number;
  avg_bidders_per_lot: number;
  total_revenue: number;
};

async function loadScalars(range: IsoDateRange): Promise<AuctionScalars> {
  const res = await db.execute<AuctionScalars>(sql`
    WITH scoped AS (
      SELECT a.auction_id, a.status, a.client_id
      FROM auctions a
      WHERE a.is_active = true
        AND a.auction_date::date >= CAST(${range.from} AS date)
        AND a.auction_date::date <= CAST(${range.to} AS date)
    ),
    scoped_lots AS (
      SELECT
        l.id AS lot_id,
        s.client_id,
        CAST(l.quantity AS decimal(38, 6)) AS qty,
        CAST(l.start_bid_price AS decimal(38, 6)) AS start_price,
        CAST(l.winning_amount AS decimal(38, 6)) AS unit_price,
        l.bidder_count,
        s.status
      FROM auction_lots l
      INNER JOIN scoped s ON s.auction_id = l.auction_id
      WHERE l.is_active = true
    ),
    lift_by_lot AS (
      SELECT
        sl.lot_id,
        COALESCE(SUM(
          CAST(ll.qty AS decimal(38, 6)) * sl.unit_price
        ), 0) AS lifted_amount
      FROM scoped_lots sl
      INNER JOIN lifting_client_logs ll
        ON ll.lot_id = sl.lot_id
       AND ll.client_id = sl.client_id
      WHERE sl.status = 'closed'
        AND sl.unit_price IS NOT NULL
      GROUP BY sl.lot_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM scoped) AS auctions_conducted,
      (
        SELECT COALESCE(SUM(
          COALESCE(sl.start_price, 0) * sl.qty
        ), 0)
        FROM scoped_lots sl
        WHERE sl.status = 'closed'
      ) AS auctioned_value,
      (
        SELECT COALESCE(SUM(COALESCE(lb.lifted_amount, 0)), 0)
        FROM scoped_lots sl
        LEFT JOIN lift_by_lot lb ON lb.lot_id = sl.lot_id
        WHERE sl.status = 'closed'
      ) AS lifted_value,
      (
        SELECT COALESCE(AVG(bidder_count), 0)
        FROM scoped_lots
      ) AS avg_bidders_per_lot,
      (
        (
          SELECT COALESCE(SUM(s.amount), 0)
          FROM subscriptions s
          WHERE s.invoice_status <> 'cancelled'
            AND s.created_at::date >= CAST(${range.from} AS date)
            AND s.created_at::date <= CAST(${range.to} AS date)
        )
        +
        (
          SELECT COALESCE(SUM(si.grand_total), 0)
          FROM service_invoices si
          WHERE si.generated_at IS NOT NULL
            AND si.generated_at::date >= CAST(${range.from} AS date)
            AND si.generated_at::date <= CAST(${range.to} AS date)
        )
      ) AS total_revenue
  `);
  const row = res.rows[0];
  return {
    auctions_conducted: num(row?.auctions_conducted),
    auctioned_value: num(row?.auctioned_value),
    lifted_value: num(row?.lifted_value),
    avg_bidders_per_lot: num(row?.avg_bidders_per_lot),
    total_revenue: num(row?.total_revenue),
  };
}

export async function getAuctions(
  range: IsoDateRange,
): Promise<AuctionsDashboard> {
  const currentPeriodLabel = formatDashboardPeriodLabel(range);
  const grain = resolveMaterialSeriesGrain(range);
  const truncUnit = sql.raw(`'${grain}'`);

  const [current, seriesRes] = await Promise.all([
    loadScalars(range),
    db.execute<{
      period: string;
      auctions: number;
      auctioned_value: number;
      lifted_value: number;
    }>(sql`
      WITH scoped_lots AS (
        SELECT
          l.id AS lot_id,
          a.client_id,
          CAST(l.quantity AS decimal(38, 6)) AS qty,
          CAST(l.start_bid_price AS decimal(38, 6)) AS start_price,
          CAST(l.winning_amount AS decimal(38, 6)) AS unit_price,
          a.status,
          date_trunc(${truncUnit}, a.auction_date)::date AS bucket_start
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        WHERE a.is_active = true
          AND l.is_active = true
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
      ),
      lift_by_lot AS (
        SELECT
          sl.lot_id,
          COALESCE(SUM(
            CAST(ll.qty AS decimal(38, 6)) * sl.unit_price
          ), 0) AS lifted_amount
        FROM scoped_lots sl
        INNER JOIN lifting_client_logs ll
          ON ll.lot_id = sl.lot_id
         AND ll.client_id = sl.client_id
        WHERE sl.status = 'closed'
          AND sl.unit_price IS NOT NULL
        GROUP BY sl.lot_id
      ),
      auction_counts AS (
        SELECT
          date_trunc(${truncUnit}, a.auction_date)::date AS bucket_start,
          COUNT(DISTINCT a.auction_id)::int AS auctions
        FROM auctions a
        WHERE a.is_active = true
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
        GROUP BY 1
      )
      SELECT
        COALESCE(ac.bucket_start, sl.bucket_start)::text AS period,
        COALESCE(MAX(ac.auctions), 0)::int AS auctions,
        COALESCE(SUM(
          CASE
            WHEN sl.status = 'closed'
            THEN COALESCE(sl.start_price, 0) * sl.qty
            ELSE 0
          END
        ), 0) AS auctioned_value,
        COALESCE(SUM(
          CASE
            WHEN sl.status = 'closed'
            THEN COALESCE(lb.lifted_amount, 0)
            ELSE 0
          END
        ), 0) AS lifted_value
      FROM auction_counts ac
      FULL OUTER JOIN scoped_lots sl ON sl.bucket_start = ac.bucket_start
      LEFT JOIN lift_by_lot lb ON lb.lot_id = sl.lot_id
      GROUP BY COALESCE(ac.bucket_start, sl.bucket_start)
      ORDER BY 1
    `),
  ]);

  return {
    stats: {
      auctionsConducted: current.auctions_conducted,
      auctionedValue: current.auctioned_value,
      liftedValue: current.lifted_value,
      avgBiddersPerLot: current.avg_bidders_per_lot,
      totalRevenue: current.total_revenue,
    },
    series: seriesRes.rows.map((r) => {
      const period = toPeriodIso(r.period);
      return {
        period,
        periodLabel: formatDashboardBucketLabel(period, grain),
        auctions: num(r.auctions),
        auctionedValue: num(r.auctioned_value),
        liftedValue: num(r.lifted_value),
      };
    }),
    currentPeriodLabel,
  };
}

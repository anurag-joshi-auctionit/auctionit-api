import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  formatDashboardBucketLabel,
  formatDashboardPeriodLabel,
  resolveMaterialSeriesGrain,
  type IsoDateRange,
} from "../../lib/dashboard/period.js";
import { num, toPeriodIso } from "./helpers.js";

export type LiftingDashboardStats = {
  auctionedValue: number;
  bidValue: number;
  approvedValue: number;
  liftedValue: number;
};

export type LiftingSeriesPoint = {
  period: string;
  periodLabel: string;
  auctionedValue: number;
  bidValue: number;
  approvedValue: number;
  liftedValue: number;
};

export type LiftingDashboard = {
  stats: LiftingDashboardStats;
  series: LiftingSeriesPoint[];
  currentPeriodLabel: string;
};

type LiftingScalars = {
  auctioned_value: number;
  bid_value: number;
  approved_value: number;
  lifted_value: number;
};

async function loadScalars(range: IsoDateRange): Promise<LiftingScalars> {
  const res = await db.execute<LiftingScalars>(sql`
    WITH scoped_lots AS (
      SELECT
        l.id AS lot_id,
        a.client_id,
        CAST(l.quantity AS decimal(38, 6)) AS qty,
        CAST(l.start_bid_price AS decimal(38, 6)) AS start_price,
        CAST(l.winning_amount AS decimal(38, 6)) AS unit_price,
        l.bid_count,
        l.bidder_count,
        l.is_approved,
        l.winner_bidder_id
      FROM auction_lots l
      INNER JOIN auctions a ON a.auction_id = l.auction_id
      WHERE a.is_active = true
        AND a.status = 'closed'
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
      WHERE sl.unit_price IS NOT NULL
      GROUP BY sl.lot_id
    )
    SELECT
      COALESCE(SUM(
        COALESCE(sl.start_price, 0) * sl.qty
      ), 0) AS auctioned_value,
      COALESCE(SUM(
        CASE
          WHEN (sl.bid_count > 0 OR sl.bidder_count > 0)
            AND sl.unit_price IS NOT NULL
          THEN sl.unit_price * sl.qty
          ELSE 0
        END
      ), 0) AS bid_value,
      COALESCE(SUM(
        CASE
          WHEN sl.is_approved = true
            AND sl.winner_bidder_id IS NOT NULL
            AND sl.unit_price IS NOT NULL
          THEN sl.unit_price * sl.qty
          ELSE 0
        END
      ), 0) AS approved_value,
      COALESCE(SUM(COALESCE(lb.lifted_amount, 0)), 0) AS lifted_value
    FROM scoped_lots sl
    LEFT JOIN lift_by_lot lb ON lb.lot_id = sl.lot_id
  `);
  const row = res.rows[0];
  return {
    auctioned_value: num(row?.auctioned_value),
    bid_value: num(row?.bid_value),
    approved_value: num(row?.approved_value),
    lifted_value: num(row?.lifted_value),
  };
}

export async function getLifting(
  range: IsoDateRange,
): Promise<LiftingDashboard> {
  const currentPeriodLabel = formatDashboardPeriodLabel(range);
  const grain = resolveMaterialSeriesGrain(range);
  const truncUnit = sql.raw(`'${grain}'`);

  const [current, seriesRes] = await Promise.all([
    loadScalars(range),
    db.execute<{
      period: string;
      auctioned_value: number;
      bid_value: number;
      approved_value: number;
      lifted_value: number;
    }>(sql`
      WITH scoped_lots AS (
        SELECT
          l.id AS lot_id,
          a.client_id,
          CAST(l.quantity AS decimal(38, 6)) AS qty,
          CAST(l.start_bid_price AS decimal(38, 6)) AS start_price,
          CAST(l.winning_amount AS decimal(38, 6)) AS unit_price,
          l.bid_count,
          l.bidder_count,
          l.is_approved,
          l.winner_bidder_id,
          date_trunc(${truncUnit}, a.auction_date)::date AS bucket_start
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        WHERE a.is_active = true
          AND a.status = 'closed'
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
        WHERE sl.unit_price IS NOT NULL
        GROUP BY sl.lot_id
      )
      SELECT
        sl.bucket_start::text AS period,
        COALESCE(SUM(
          COALESCE(sl.start_price, 0) * sl.qty
        ), 0) AS auctioned_value,
        COALESCE(SUM(
          CASE
            WHEN (sl.bid_count > 0 OR sl.bidder_count > 0)
              AND sl.unit_price IS NOT NULL
            THEN sl.unit_price * sl.qty
            ELSE 0
          END
        ), 0) AS bid_value,
        COALESCE(SUM(
          CASE
            WHEN sl.is_approved = true
              AND sl.winner_bidder_id IS NOT NULL
              AND sl.unit_price IS NOT NULL
            THEN sl.unit_price * sl.qty
            ELSE 0
          END
        ), 0) AS approved_value,
        COALESCE(SUM(COALESCE(lb.lifted_amount, 0)), 0) AS lifted_value
      FROM scoped_lots sl
      LEFT JOIN lift_by_lot lb ON lb.lot_id = sl.lot_id
      GROUP BY sl.bucket_start
      ORDER BY sl.bucket_start
    `),
  ]);

  return {
    stats: {
      auctionedValue: current.auctioned_value,
      bidValue: current.bid_value,
      approvedValue: current.approved_value,
      liftedValue: current.lifted_value,
    },
    series: seriesRes.rows.map((r) => {
      const period = toPeriodIso(r.period);
      return {
        period,
        periodLabel: formatDashboardBucketLabel(period, grain),
        auctionedValue: num(r.auctioned_value),
        bidValue: num(r.bid_value),
        approvedValue: num(r.approved_value),
        liftedValue: num(r.lifted_value),
      };
    }),
    currentPeriodLabel,
  };
}

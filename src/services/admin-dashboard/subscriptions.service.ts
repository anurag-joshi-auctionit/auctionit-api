import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  formatDashboardBucketLabel,
  formatDashboardPeriodLabel,
  resolveMaterialSeriesGrain,
  type IsoDateRange,
} from "../../lib/dashboard/period.js";
import { num, toPeriodIso } from "./helpers.js";

export type SubscriptionsDashboardStats = {
  newSubscriptions: number;
  subscriptionAmount: number;
  activeToday: number;
  expiringIn30Days: number;
};

export type SubscriptionsSeriesPoint = {
  period: string;
  periodLabel: string;
  count: number;
  subscriptionAmount: number;
};

export type SubscriptionsDashboard = {
  stats: SubscriptionsDashboardStats;
  series: SubscriptionsSeriesPoint[];
  currentPeriodLabel: string;
};

type SubscriptionScalars = {
  new_subscriptions: number;
  subscription_amount: number;
  active_today: number;
  expiring_in_30_days: number;
};

async function loadScalars(range: IsoDateRange): Promise<SubscriptionScalars> {
  const res = await db.execute<SubscriptionScalars>(sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM subscriptions s
        WHERE s.invoice_status <> 'cancelled'
          AND s.created_at::date >= CAST(${range.from} AS date)
          AND s.created_at::date <= CAST(${range.to} AS date)
      ) AS new_subscriptions,
      (
        SELECT COALESCE(SUM(s.amount), 0)
        FROM subscriptions s
        WHERE s.invoice_status <> 'cancelled'
          AND s.created_at::date >= CAST(${range.from} AS date)
          AND s.created_at::date <= CAST(${range.to} AS date)
      ) AS subscription_amount,
      (
        SELECT COUNT(*)::int
        FROM subscriptions s
        WHERE s.invoice_status <> 'cancelled'
          AND s.from_date IS NOT NULL
          AND s.to_date IS NOT NULL
          AND s.from_date <= CURRENT_DATE
          AND s.to_date >= CURRENT_DATE
      ) AS active_today,
      (
        SELECT COUNT(*)::int
        FROM subscriptions s
        WHERE s.invoice_status <> 'cancelled'
          AND s.to_date IS NOT NULL
          AND s.to_date >= CURRENT_DATE
          AND s.to_date <= CURRENT_DATE + INTERVAL '30 days'
      ) AS expiring_in_30_days
  `);
  const row = res.rows[0];
  return {
    new_subscriptions: num(row?.new_subscriptions),
    subscription_amount: num(row?.subscription_amount),
    active_today: num(row?.active_today),
    expiring_in_30_days: num(row?.expiring_in_30_days),
  };
}

export async function getSubscriptions(
  range: IsoDateRange,
): Promise<SubscriptionsDashboard> {
  const currentPeriodLabel = formatDashboardPeriodLabel(range);
  const grain = resolveMaterialSeriesGrain(range);
  const truncUnit = sql.raw(`'${grain}'`);

  const [current, seriesRes] = await Promise.all([
    loadScalars(range),
    db.execute<{
      period: string;
      count: number;
      subscription_amount: number;
    }>(sql`
      SELECT
        date_trunc(${truncUnit}, s.created_at)::date::text AS period,
        COUNT(*)::int AS count,
        COALESCE(SUM(s.amount), 0) AS subscription_amount
      FROM subscriptions s
      WHERE s.invoice_status <> 'cancelled'
        AND s.created_at::date >= CAST(${range.from} AS date)
        AND s.created_at::date <= CAST(${range.to} AS date)
      GROUP BY 1
      ORDER BY 1
    `),
  ]);

  return {
    stats: {
      newSubscriptions: current.new_subscriptions,
      subscriptionAmount: current.subscription_amount,
      activeToday: current.active_today,
      expiringIn30Days: current.expiring_in_30_days,
    },
    series: seriesRes.rows.map((r) => {
      const period = toPeriodIso(r.period);
      return {
        period,
        periodLabel: formatDashboardBucketLabel(period, grain),
        count: num(r.count),
        subscriptionAmount: num(r.subscription_amount),
      };
    }),
    currentPeriodLabel,
  };
}

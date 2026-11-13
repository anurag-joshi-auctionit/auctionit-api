import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  formatDashboardBucketLabel,
  formatDashboardPeriodLabel,
  resolveMaterialSeriesGrain,
  type IsoDateRange,
} from "../../lib/dashboard/period.js";
import { num, toPeriodIso } from "./helpers.js";

export type ServiceInvoicesDashboardStats = {
  generatedInRange: number;
  invoicedValue: number;
  collectedInRange: number;
  outstandingAsOnToday: number;
};

export type ServiceInvoiceSeriesPoint = {
  period: string;
  periodLabel: string;
  invoiced: number;
  collected: number;
};

export type OutstandingInvoiceRow = {
  clientId: number;
  clientName: string;
  unpaidAmount: number;
};

export type ServiceInvoicesDashboard = {
  stats: ServiceInvoicesDashboardStats;
  series: ServiceInvoiceSeriesPoint[];
  rows: OutstandingInvoiceRow[];
  currentPeriodLabel: string;
};

type InvoiceScalars = {
  generated_in_range: number;
  invoiced_value: number;
  collected_in_range: number;
  outstanding_as_on_today: number;
};

async function loadScalars(range: IsoDateRange): Promise<InvoiceScalars> {
  const res = await db.execute<InvoiceScalars>(sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM service_invoices si
        WHERE si.generated_at IS NOT NULL
          AND si.generated_at::date >= CAST(${range.from} AS date)
          AND si.generated_at::date <= CAST(${range.to} AS date)
      ) AS generated_in_range,
      (
        SELECT COALESCE(SUM(si.grand_total), 0)
        FROM service_invoices si
        WHERE si.generated_at IS NOT NULL
          AND si.generated_at::date >= CAST(${range.from} AS date)
          AND si.generated_at::date <= CAST(${range.to} AS date)
      ) AS invoiced_value,
      (
        SELECT COALESCE(SUM(pl.paid_amount), 0)
        FROM service_invoice_payment_logs pl
        WHERE pl.is_active = true
          AND pl.paid_at::date >= CAST(${range.from} AS date)
          AND pl.paid_at::date <= CAST(${range.to} AS date)
      ) AS collected_in_range,
      (
        SELECT COALESCE(SUM(si.unpaid_amount), 0)
        FROM service_invoices si
        WHERE si.status = 'generated'
          AND si.unpaid_amount > 0
      ) AS outstanding_as_on_today
  `);
  const row = res.rows[0];
  return {
    generated_in_range: num(row?.generated_in_range),
    invoiced_value: num(row?.invoiced_value),
    collected_in_range: num(row?.collected_in_range),
    outstanding_as_on_today: num(row?.outstanding_as_on_today),
  };
}

export async function getServiceInvoices(
  range: IsoDateRange,
): Promise<ServiceInvoicesDashboard> {
  const currentPeriodLabel = formatDashboardPeriodLabel(range);
  const grain = resolveMaterialSeriesGrain(range);
  const truncUnit = sql.raw(`'${grain}'`);

  const [current, invoicedSeries, collectedSeries, rowsRes] =
    await Promise.all([
      loadScalars(range),
      db.execute<{ period: string; invoiced: number }>(sql`
        SELECT
          date_trunc(${truncUnit}, si.generated_at)::date::text AS period,
          COALESCE(SUM(si.grand_total), 0) AS invoiced
        FROM service_invoices si
        WHERE si.generated_at IS NOT NULL
          AND si.generated_at::date >= CAST(${range.from} AS date)
          AND si.generated_at::date <= CAST(${range.to} AS date)
        GROUP BY 1
        ORDER BY 1
      `),
      db.execute<{ period: string; collected: number }>(sql`
        SELECT
          date_trunc(${truncUnit}, pl.paid_at)::date::text AS period,
          COALESCE(SUM(pl.paid_amount), 0) AS collected
        FROM service_invoice_payment_logs pl
        WHERE pl.is_active = true
          AND pl.paid_at::date >= CAST(${range.from} AS date)
          AND pl.paid_at::date <= CAST(${range.to} AS date)
        GROUP BY 1
        ORDER BY 1
      `),
      db.execute<{
        client_id: number;
        client_name: string;
        unpaid_amount: number;
      }>(sql`
        SELECT
          c.id AS client_id,
          c.company_name AS client_name,
          COALESCE(SUM(si.unpaid_amount), 0) AS unpaid_amount
        FROM service_invoices si
        INNER JOIN clients c ON c.id = si.client_id
        WHERE si.status = 'generated'
          AND si.unpaid_amount > 0
        GROUP BY c.id, c.company_name
        ORDER BY unpaid_amount DESC
        LIMIT 5
      `),
    ]);

  const collectedByPeriod = new Map(
    collectedSeries.rows.map((r) => [
      toPeriodIso(r.period),
      num(r.collected),
    ]),
  );
  const periodSet = new Set<string>([
    ...invoicedSeries.rows.map((r) => toPeriodIso(r.period)),
    ...collectedByPeriod.keys(),
  ]);
  const periods = [...periodSet].sort();

  return {
    stats: {
      generatedInRange: current.generated_in_range,
      invoicedValue: current.invoiced_value,
      collectedInRange: current.collected_in_range,
      outstandingAsOnToday: current.outstanding_as_on_today,
    },
    series: periods.map((period) => {
      const invoicedRow = invoicedSeries.rows.find(
        (r) => toPeriodIso(r.period) === period,
      );
      return {
        period,
        periodLabel: formatDashboardBucketLabel(period, grain),
        invoiced: num(invoicedRow?.invoiced),
        collected: collectedByPeriod.get(period) ?? 0,
      };
    }),
    rows: rowsRes.rows.map((r) => ({
      clientId: num(r.client_id),
      clientName: r.client_name,
      unpaidAmount: num(r.unpaid_amount),
    })),
    currentPeriodLabel,
  };
}

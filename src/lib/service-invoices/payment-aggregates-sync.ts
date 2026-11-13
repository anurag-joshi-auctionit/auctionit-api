import { sql, type SQL } from "drizzle-orm";

/**
 * Rebuild `service_invoices` payment aggregates from active payment logs
 * for one invoice.
 */
export function syncPaymentAggregatesForInvoiceSql(invoiceId: number): SQL {
  return sql`
    UPDATE service_invoices AS si
    SET
      paid_amount = COALESCE(agg.paid_sum, 0),
      unpaid_amount = GREATEST(0, si.grand_total - COALESCE(agg.paid_sum, 0)),
      latest_payment_date = agg.latest_paid_at,
      payment_status = CASE
        WHEN COALESCE(agg.paid_sum, 0) <= 0 THEN 'unpaid'::service_invoice_payment_status
        WHEN COALESCE(agg.paid_sum, 0) < si.grand_total THEN 'partially_paid'::service_invoice_payment_status
        ELSE 'paid'::service_invoice_payment_status
      END
    FROM (
      SELECT
        ${invoiceId}::int AS service_invoice_id,
        (
          SELECT COALESCE(SUM(CAST(paid_amount AS decimal(38, 3))), 0)
          FROM service_invoice_payment_logs
          WHERE service_invoice_id = ${invoiceId}
            AND is_active = true
        ) AS paid_sum,
        (
          SELECT paid_at
          FROM service_invoice_payment_logs
          WHERE service_invoice_id = ${invoiceId}
            AND is_active = true
          ORDER BY paid_at DESC, id DESC
          LIMIT 1
        ) AS latest_paid_at
    ) AS agg
    WHERE si.id = ${invoiceId}
      AND agg.service_invoice_id = si.id
  `;
}

/**
 * Bulk backfill payment aggregates for all service invoices.
 * Used by seed (raw `pg` client).
 */
export const BACKFILL_SERVICE_INVOICE_PAYMENT_AGGREGATES_SQL = `
UPDATE service_invoices AS si
SET
  paid_amount = COALESCE(agg.paid_sum, 0),
  unpaid_amount = GREATEST(0, si.grand_total - COALESCE(agg.paid_sum, 0)),
  latest_payment_date = agg.latest_paid_at,
  payment_status = CASE
    WHEN COALESCE(agg.paid_sum, 0) <= 0 THEN 'unpaid'::service_invoice_payment_status
    WHEN COALESCE(agg.paid_sum, 0) < si.grand_total THEN 'partially_paid'::service_invoice_payment_status
    ELSE 'paid'::service_invoice_payment_status
  END
FROM (
  SELECT
    si2.id AS service_invoice_id,
    COALESCE(sums.paid_sum, 0) AS paid_sum,
    latest.latest_paid_at
  FROM service_invoices AS si2
  LEFT JOIN (
    SELECT
      service_invoice_id,
      SUM(CAST(paid_amount AS decimal(38, 3))) AS paid_sum
    FROM service_invoice_payment_logs
    WHERE is_active = true
    GROUP BY service_invoice_id
  ) AS sums ON sums.service_invoice_id = si2.id
  LEFT JOIN (
    SELECT DISTINCT ON (service_invoice_id)
      service_invoice_id,
      paid_at AS latest_paid_at
    FROM service_invoice_payment_logs
    WHERE is_active = true
    ORDER BY service_invoice_id, paid_at DESC, id DESC
  ) AS latest ON latest.service_invoice_id = si2.id
) AS agg
WHERE si.id = agg.service_invoice_id
`;

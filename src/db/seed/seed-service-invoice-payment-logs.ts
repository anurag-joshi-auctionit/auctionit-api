import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { upsertBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";
import { BACKFILL_SERVICE_INVOICE_PAYMENT_AGGREGATES_SQL } from "../../lib/service-invoices/payment-aggregates-sync.js";

/**
 * MSSQL `tbl_Data_ServiceInvoicePaymentDetails`
 * → Postgres `service_invoice_payment_logs`.
 */
const SOURCE_SQL = `
SELECT
  SIPId AS id,
  ServiceInvoiceId AS serviceInvoiceId,
  PaymentAmount AS paidAmount,
  CONVERT(varchar(33), PaymentReceivedDate, 126) AS paidAt,
  CONVERT(varchar(33), CreatedOn, 126) AS createdAt,
  CreatedBy AS createdBy,
  CONVERT(varchar(33), UpdatedOn, 126) AS updatedAt,
  UpdatedBy AS updatedBy,
  CAST(ISNULL(IsActive, 1) AS bit) AS isActive
FROM tbl_Data_ServiceInvoicePaymentDetails
ORDER BY SIPId
`;

const HEAD_SQL = `
INSERT INTO service_invoice_payment_logs (
  id, service_invoice_id, paid_amount, paid_at,
  is_active, created_at, created_by, updated_at, updated_by
)`;

const TAIL_SQL = `
ON CONFLICT (id) DO UPDATE SET
  service_invoice_id = EXCLUDED.service_invoice_id,
  paid_amount = EXCLUDED.paid_amount,
  paid_at = EXCLUDED.paid_at,
  is_active = EXCLUDED.is_active,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

function asString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" || t === "null" ? null : t;
}

function numericOrNull(v: string | number | null | undefined): string | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(v) : null;
}

function intOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function boolOrTrue(v: unknown): boolean {
  if (v === false || v === 0 || v === "0" || v === "false") return false;
  return true;
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} service invoice payment log rows from MSSQL.`,
    );

    const [invoiceIds, userIds] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM service_invoices"),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
    ]);
    const validInvoiceIds = new Set(invoiceIds.rows.map((r) => r.id));
    const validUserIds = new Set(userIds.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);

    // Build rows in-memory (9 params each)
    const rows: unknown[][] = [];
    let skippedNullId = 0;
    let skippedMissingInvoice = 0;
    let skippedMissingRequired = 0;

    for (const r of result.recordset) {
      const id = intOrNull(r.id);
      const serviceInvoiceId = intOrNull(r.serviceInvoiceId);
      const paidAmount = numericOrNull(r.paidAmount);
      const paidAt = asString(r.paidAt);

      if (id == null) { skippedNullId++; continue; }
      if (serviceInvoiceId == null || !validInvoiceIds.has(serviceInvoiceId)) { skippedMissingInvoice++; continue; }
      if (paidAmount == null || !paidAt) { skippedMissingRequired++; continue; }

      const updatedAt = asString(r.updatedAt);
      rows.push([
        id,
        serviceInvoiceId,
        Number(paidAmount).toFixed(3),
        paidAt,
        boolOrTrue(r.isActive),
        asString(r.createdAt),
        resolveAuditUserId(intOrNull(r.createdBy), validUserIds),
        updatedAt,
        resolveAuditUserIdIfTimestamp(updatedAt, intOrNull(r.updatedBy), validUserIds),
      ]);
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await upsertBatched(client, "service_invoice_payment_logs", HEAD_SQL, TAIL_SQL, rows);
      const backfill = await client.query(BACKFILL_SERVICE_INVOICE_PAYMENT_AGGREGATES_SQL);
      await client.query("COMMIT");

      console.log(
        `Upserted ${rows.length} service_invoice_payment_logs rows ` +
          `(${skippedNullId} skipped: null id, ` +
          `${skippedMissingInvoice} skipped: invoice not in Postgres, ` +
          `${skippedMissingRequired} skipped: missing paid amount/date).`,
      );
      console.log(
        `Backfilled payment aggregates on service_invoices: ${backfill.rowCount ?? 0} rows in ${Date.now() - started}ms.`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

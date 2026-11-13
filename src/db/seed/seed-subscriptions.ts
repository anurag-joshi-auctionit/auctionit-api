import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";

// Subscription payment ledger from legacy tbl_Data_PaymentTransaction.
const SOURCE_SQL = `
SELECT
  PaymentId                                          AS id,
  BidderCompId                                       AS bidderId,
  SubscriptionTypeId                                 AS subscriptionTypeId,
  CONVERT(varchar(10), FromDate, 23)                 AS fromDate,
  CONVERT(varchar(10), ToDate, 23)                   AS toDate,
  CONVERT(varchar(40), SubscriptionPrice)            AS subscriptionPrice,
  CONVERT(varchar(40), GstAmount)                    AS gstAmount,
  CONVERT(varchar(40), Amount)                       AS amount,
  PaymentMode                                        AS paymentMode,
  TransId                                            AS transactionId,
  CONVERT(varchar(10), PaymentDate, 23)              AS paymentDate,
  Remark                                             AS remarks,
  FileName                                           AS fileName,
  InvoiceFormat                                      AS invoiceFormat,
  InvoiceGeneratedBy                                 AS invoiceGeneratedBy,
  CONVERT(varchar(10), InvoiceCreatedDate, 23)       AS invoiceCreatedDate,
  CONVERT(varchar(33), InvoiceUploadDateTime, 126)   AS invoiceUploadDateTime,
  EmailSentBy                                        AS emailSentBy,
  CONVERT(varchar(33), EmailSentDate, 126)           AS emailSentAt,
  CreatedBy                                          AS createdBy,
  CONVERT(varchar(33), CreatedOn, 126)               AS createdAt,
  UpdatedBy                                          AS updatedBy,
  CONVERT(varchar(33), UpdatedOn, 126)               AS updatedAt
FROM tbl_Data_PaymentTransaction
ORDER BY PaymentId
`;

const UPSERT_SQL = `
INSERT INTO subscriptions (
  id, bidder_id, subscription_type_id,
  from_date, to_date,
  subscription_price, gst_amount, amount,
  payment_mode, transaction_id, payment_date, remarks,
  invoice_status, invoice_number, invoice_date,
  invoice_generated_at, invoice_generated_by,
  email_sent_at, email_sent_by,
  created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3,
  $4, $5,
  $6, $7, $8,
  $9, $10, $11, $12,
  $13, $14, $15,
  $16, $17,
  $18, $19,
  $20, $21, $22, $23
)
ON CONFLICT (id) DO UPDATE SET
  bidder_id = EXCLUDED.bidder_id,
  subscription_type_id = EXCLUDED.subscription_type_id,
  from_date = EXCLUDED.from_date,
  to_date = EXCLUDED.to_date,
  subscription_price = EXCLUDED.subscription_price,
  gst_amount = EXCLUDED.gst_amount,
  amount = EXCLUDED.amount,
  payment_mode = EXCLUDED.payment_mode,
  transaction_id = EXCLUDED.transaction_id,
  payment_date = EXCLUDED.payment_date,
  remarks = EXCLUDED.remarks,
  invoice_status = EXCLUDED.invoice_status,
  invoice_number = EXCLUDED.invoice_number,
  invoice_date = EXCLUDED.invoice_date,
  invoice_generated_at = EXCLUDED.invoice_generated_at,
  invoice_generated_by = EXCLUDED.invoice_generated_by,
  email_sent_at = EXCLUDED.email_sent_at,
  email_sent_by = EXCLUDED.email_sent_by,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
  id: string | number;
  bidderId: string | number | null;
  subscriptionTypeId: number | null;
  fromDate: string | null;
  toDate: string | null;
  subscriptionPrice: string | number | null;
  gstAmount: string | number | null;
  amount: string | number | null;
  paymentMode: number | null;
  transactionId: string | null;
  paymentDate: string | null;
  remarks: string | null;
  fileName: string | null;
  invoiceFormat: string | null;
  invoiceGeneratedBy: string | number | null;
  invoiceCreatedDate: string | null;
  invoiceUploadDateTime: string | null;
  emailSentBy: string | number | null;
  emailSentAt: string | null;
  createdBy: string | number | null;
  createdAt: string | null;
  updatedBy: string | number | null;
  updatedAt: string | null;
};

function toIntOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numericOrZero(v: string | number | null | undefined): string {
  if (v == null) return "0";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "0";
}

function asString(v: string | null | undefined, max = 2000): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;
  return t.length > max ? t.slice(0, max) : t;
}

function dateOnly(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.slice(0, 10);
}

function isGeneratedInvoice(r: SourceRow): boolean {
  return Boolean(asString(r.fileName, 100) || asString(r.invoiceFormat, 30));
}

/** Legacy NULL/0 subscription type → placeholder id 0. */
function coerceSubscriptionTypeId(
  v: string | number | null | undefined,
): number {
  const n = toIntOrNull(v);
  return n == null || n <= 0 ? 0 : n;
}

async function ensureLegacyPlaceholders(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO subscription_types (
       id, name, amount, gst_percent, months, is_active, created_at, created_by
     ) VALUES (0, 'Unknown', 0, 0, 0, false, NOW(), $1)
     ON CONFLICT (id) DO NOTHING`,
    [SEED_DEFAULT_USER_ID],
  );
  await client.query(
    `INSERT INTO bidders (id, company_name, materials, is_active, is_verified, created_at, created_by)
     VALUES (0, '(Legacy unknown bidder)', ARRAY[]::integer[], false, false, NOW(), $1)
     ON CONFLICT (id) DO NOTHING`,
    [SEED_DEFAULT_USER_ID],
  );
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} payment transactions from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const client = await pgPool.connect();
    let upserted = 0;
    let generatedCount = 0;
    let skippedNullId = 0;
    let skippedMissingBidder = 0;
    let skippedMissingType = 0;
    try {
      await ensureLegacyPlaceholders(client);

      const bidderIds = new Set(
        (await client.query<{ id: number }>("SELECT id FROM bidders")).rows.map(
          (r) => r.id,
        ),
      );
      const typeIds = new Set(
        (
          await client.query<{ id: number }>(
            "SELECT id FROM subscription_types",
          )
        ).rows.map((r) => r.id),
      );
      const modeIds = new Set(
        (
          await client.query<{ id: number }>("SELECT id FROM payment_types")
        ).rows.map((r) => r.id),
      );
      const userIds = new Set(
        (await client.query<{ id: number }>("SELECT id FROM users")).rows.map(
          (r) => r.id,
        ),
      );
      userIds.add(SEED_DEFAULT_USER_ID);

      await client.query("BEGIN");
      for (const r of result.recordset) {
        const id = toIntOrNull(r.id);
        // BidderCompId 0 is acceptable legacy data (placeholder bidder id 0).
        const bidderId = toIntOrNull(r.bidderId) ?? 0;
        const subscriptionTypeId = coerceSubscriptionTypeId(
          r.subscriptionTypeId,
        );
        if (id == null) {
          skippedNullId++;
          continue;
        }
        if (!bidderIds.has(bidderId)) {
          skippedMissingBidder++;
          continue;
        }
        if (!typeIds.has(subscriptionTypeId)) {
          skippedMissingType++;
          continue;
        }

        let paymentMode = toIntOrNull(r.paymentMode);
        if (paymentMode != null && !modeIds.has(paymentMode)) {
          paymentMode = null;
        }

        const createdBy = resolveAuditUserId(toIntOrNull(r.createdBy), userIds);
        const updatedBy = resolveAuditUserIdIfTimestamp(
          r.updatedAt,
          toIntOrNull(r.updatedBy),
          userIds,
        );

        const generated = isGeneratedInvoice(r);
        if (generated) generatedCount++;
        const invoiceStatus = generated ? "generated" : "requested";
        const invoiceNumber = asString(r.invoiceFormat, 30);
        const invoiceDate = dateOnly(r.invoiceCreatedDate);
        const invoiceGeneratedAt = generated
          ? (r.invoiceUploadDateTime ?? null)
          : null;
        const invoiceGeneratedBy = generated
          ? resolveAuditUserId(toIntOrNull(r.invoiceGeneratedBy), userIds)
          : null;
        const emailSentByRaw = toIntOrNull(r.emailSentBy);
        const emailSentBy =
          emailSentByRaw != null && userIds.has(emailSentByRaw)
            ? emailSentByRaw
            : null;
        const emailSentAt =
          r.emailSentAt && r.emailSentAt !== "null" ? r.emailSentAt : null;

        await client.query(UPSERT_SQL, [
          id,
          bidderId,
          subscriptionTypeId,
          dateOnly(r.fromDate),
          dateOnly(r.toDate),
          numericOrZero(r.subscriptionPrice),
          numericOrZero(r.gstAmount),
          numericOrZero(r.amount),
          paymentMode,
          asString(r.transactionId, 100),
          dateOnly(r.paymentDate),
          asString(r.remarks, 2000),
          invoiceStatus,
          invoiceNumber,
          invoiceDate,
          invoiceGeneratedAt,
          invoiceGeneratedBy,
          emailSentAt,
          emailSentBy,
          r.createdAt ?? new Date().toISOString(),
          createdBy,
          r.updatedAt,
          updatedBy,
        ]);
        upserted++;
      }
      await client.query(
        `SELECT setval(pg_get_serial_sequence('subscriptions', 'id'), COALESCE((SELECT MAX(id) FROM subscriptions), 1))`,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Upserted ${upserted} subscriptions ` +
        `(${generatedCount} invoice status=generated, ` +
        `${skippedNullId} skipped: null id, ` +
        `${skippedMissingBidder} skipped: bidder not in Postgres, ` +
        `${skippedMissingType} skipped: subscription type not in Postgres) ` +
        `in ${Date.now() - started}ms.`,
    );
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

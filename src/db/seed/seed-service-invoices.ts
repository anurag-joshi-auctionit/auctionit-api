import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import { asString } from "./resolve-location-id.js";
import { computeServiceFeeAmount } from "../../lib/service-invoices/fee-calc.js";
import { addDaysToDateOnly } from "../../lib/service-invoices/date-only.js";

const SRT_PERCENTAGE = 34;
const SRT_FIXED = 35;
const SRT_PMT = 36;
const SRT_MIXED = 37;

const TYPE_AUTO = 30;
const TYPE_MANUAL = 31;

const SOURCE_SQL = `
SELECT
  ServiceInvoiceId AS serviceInvoiceId,
  ClientId AS clientId,
  LocationId AS locationId,
  CONVERT(varchar(33), FromDate, 126) AS fromDate,
  CONVERT(varchar(33), ToDate, 126) AS toDate,
  TypeId AS typeId,
  OrderNumber AS orderNumber,
  CONVERT(varchar(33), OrderNumberDate, 126) AS orderDate,
  GracePeriod AS gracePeriod,
  TotalQuantity AS totalQuantity,
  TotalQuantityMT AS totalQuantityMT,
  TotalAmount AS totalAmount,
  SRTId AS srtId,
  ServiceFeePer AS serviceFeePer,
  AmountPMT AS amountPmt,
  ServiceAmount AS serviceAmount,
  ServiceAmountPMT AS serviceAmountPmt,
  GSTPer AS gstPer,
  GSTAmount AS gstAmount,
  GrandTotal AS grandTotal,
  RoundOff AS roundOff,
  ServiceChargeDescription AS serviceChargeDescription,
  InvoiceFormat AS invoiceFormat,
  CONVERT(varchar(10), InvoiceCreatedDate, 23) AS invoiceDate,
  CONVERT(varchar(10), PaymentDueDate, 23) AS paymentDueDate,
  InvoiceGeneratedBy AS invoiceGeneratedBy,
  CONVERT(varchar(33), InvoiceGeneratedActualDate, 126) AS invoiceGeneratedActualDate,
  EmailSentBy AS emailSentBy,
  CONVERT(varchar(33), EmailSentDate, 126) AS emailSentAt,
  VerifyStatusId AS verifyStatusId,
  CONVERT(varchar(33), CreatedOn, 126) AS createdAt,
  CreatedBy AS createdBy,
  CONVERT(varchar(33), UpdatedOn, 126) AS updatedAt,
  UpdatedBy AS updatedBy
FROM tbl_Data_ServiceInvoice
`;

const UPSERT_SQL = `
INSERT INTO service_invoices (
  id, client_id, plant_location_id, from_date, to_date, type,
  order_number, order_date, grace_period,
  total_quantity, total_amount,
  service_fee_type, service_fee_value, service_fee_amount,
  gst_percent, gst_amount, grand_total, round_off,
  service_charge_description, invoice_number, invoice_date, payment_due_date,
  paid_amount, unpaid_amount, latest_payment_date, payment_status,
  status, generated_at, generated_by, email_sent_at, email_sent_by,
  created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9,
  $10, $11,
  $12, $13, $14,
  $15, $16, $17, $18,
  $19, $20, $21, $22,
  0, $17, NULL, 'unpaid',
  $23, $24, $25, $26, $27,
  $28, $29, $30, $31
)
ON CONFLICT (id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  plant_location_id = EXCLUDED.plant_location_id,
  from_date = EXCLUDED.from_date,
  to_date = EXCLUDED.to_date,
  type = EXCLUDED.type,
  order_number = EXCLUDED.order_number,
  order_date = EXCLUDED.order_date,
  grace_period = EXCLUDED.grace_period,
  total_quantity = EXCLUDED.total_quantity,
  total_amount = EXCLUDED.total_amount,
  service_fee_type = EXCLUDED.service_fee_type,
  service_fee_value = EXCLUDED.service_fee_value,
  service_fee_amount = EXCLUDED.service_fee_amount,
  gst_percent = EXCLUDED.gst_percent,
  gst_amount = EXCLUDED.gst_amount,
  grand_total = EXCLUDED.grand_total,
  round_off = EXCLUDED.round_off,
  service_charge_description = EXCLUDED.service_charge_description,
  invoice_number = EXCLUDED.invoice_number,
  invoice_date = EXCLUDED.invoice_date,
  payment_due_date = EXCLUDED.payment_due_date,
  unpaid_amount = EXCLUDED.grand_total - service_invoices.paid_amount,
  payment_status = CASE
    WHEN service_invoices.paid_amount <= 0 THEN 'unpaid'::service_invoice_payment_status
    WHEN service_invoices.paid_amount < EXCLUDED.grand_total THEN 'partially_paid'::service_invoice_payment_status
    ELSE 'paid'::service_invoice_payment_status
  END,
  status = EXCLUDED.status,
  generated_at = EXCLUDED.generated_at,
  generated_by = EXCLUDED.generated_by,
  email_sent_at = EXCLUDED.email_sent_at,
  email_sent_by = EXCLUDED.email_sent_by,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
  serviceInvoiceId: number;
  clientId: number | null;
  locationId: number | null;
  fromDate: string;
  toDate: string;
  typeId: number | null;
  orderNumber: string | null;
  orderDate: string | null;
  gracePeriod: number | null;
  totalQuantity: number | null;
  totalQuantityMT: number | null;
  totalAmount: number | null;
  srtId: number | null;
  serviceFeePer: number | null;
  amountPmt: number | null;
  serviceAmount: number | null;
  serviceAmountPmt: number | null;
  gstPer: number | null;
  gstAmount: number | null;
  grandTotal: number | null;
  roundOff: number | string | null;
  serviceChargeDescription: string | null;
  invoiceFormat: string | null;
  invoiceDate: string | null;
  paymentDueDate: string | null;
  invoiceGeneratedBy: number | null;
  invoiceGeneratedActualDate: string | null;
  emailSentBy: number | null;
  emailSentAt: string | null;
  verifyStatusId: number | null;
  createdAt: string | null;
  createdBy: number | null;
  updatedAt: string | null;
  updatedBy: number | null;
};

type FeeType = "service_percentage" | "fixed_amount" | "pmt";
type InvoiceType = "auto" | "manual";
type InvoiceStatus =
  | "draft"
  | "requested"
  | "generated"
  | "recheck"
  | "cancelled";

function toNum(v: number | string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** MSSQL tedious often returns ints as strings; PG Set keys are numbers. */
function toId(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapType(typeId: number | string | null): InvoiceType {
  if (toId(typeId) === TYPE_AUTO) return "auto";
  return "manual";
}

function mapStatus(
  verifyStatusId: number | string | null,
): InvoiceStatus | null {
  switch (toId(verifyStatusId)) {
    case 0:
      return "draft";
    case 1:
      return "requested";
    case 2:
      return "generated";
    case 3:
      return "recheck";
    default:
      return null;
  }
}

function roundOffString(
  v: number | string | null | undefined,
): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

function invoiceDateOnly(v: string | null | undefined): string | null {
  if (v == null || v === "" || v === "null") return null;
  const day = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function mapFee(row: SourceRow): {
  serviceFeeType: FeeType;
  serviceFeeValue: number;
  totalQuantity: number;
  totalAmount: number;
  serviceFeeAmount: number;
} | null {
  const srtId = toId(row.srtId);
  const totalAmount = toNum(row.totalAmount);

  if (srtId === SRT_PERCENTAGE) {
    const serviceFeeValue = toNum(row.serviceFeePer);
    const totalQuantity = toNum(row.totalQuantity);
    const legacyAmount = toNum(row.serviceAmount);
    const computed = computeServiceFeeAmount(
      "service_percentage",
      serviceFeeValue,
      totalQuantity,
      totalAmount,
    );
    return {
      serviceFeeType: "service_percentage",
      serviceFeeValue,
      totalQuantity,
      totalAmount,
      serviceFeeAmount: legacyAmount || computed,
    };
  }

  if (srtId === SRT_FIXED) {
    const serviceFeeValue = toNum(row.serviceAmount);
    return {
      serviceFeeType: "fixed_amount",
      serviceFeeValue,
      totalQuantity: toNum(row.totalQuantity),
      totalAmount,
      serviceFeeAmount: serviceFeeValue,
    };
  }

  if (srtId === SRT_PMT) {
    const serviceFeeValue = toNum(row.amountPmt);
    const totalQuantity = toNum(row.totalQuantityMT);
    const legacyAmount =
      toNum(row.serviceAmountPmt) || toNum(row.serviceAmount);
    const computed = computeServiceFeeAmount(
      "pmt",
      serviceFeeValue,
      totalQuantity,
      totalAmount,
    );
    return {
      serviceFeeType: "pmt",
      serviceFeeValue,
      totalQuantity,
      totalAmount,
      serviceFeeAmount: legacyAmount || computed,
    };
  }

  return null;
}

async function loadIdSet(
  pool: pg.Pool,
  table: string,
): Promise<Set<number>> {
  const res = await pool.query<{ id: number }>(`SELECT id FROM ${table}`);
  return new Set(res.rows.map((r) => r.id));
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} service invoice rows from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [clientIds, plantIds, userIds] = await Promise.all([
      loadIdSet(pgPool, "clients"),
      loadIdSet(pgPool, "plant_locations"),
      loadIdSet(pgPool, "users"),
    ]);
    userIds.add(SEED_DEFAULT_USER_ID);

    const client = await pgPool.connect();
    let upserted = 0;
    let skippedClient = 0;
    let skippedPlant = 0;
    let skippedStatus = 0;
    let skippedUnknownSrt = 0;
    const mixedSkipped: number[] = [];
    const feeMismatch: Array<{ id: number; legacy: number; computed: number }> =
      [];
    let defaultedCreatedBy = 0;

    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        const serviceInvoiceId = toId(r.serviceInvoiceId);
        const clientId = toId(r.clientId);
        const locationId = toId(r.locationId);
        const srtId = toId(r.srtId);
        const createdByRaw = toId(r.createdBy);
        const updatedByRaw = toId(r.updatedBy);

        if (srtId === SRT_MIXED) {
          if (serviceInvoiceId != null) mixedSkipped.push(serviceInvoiceId);
          continue;
        }

        const fee = mapFee(r);
        if (!fee) {
          skippedUnknownSrt++;
          continue;
        }

        if (clientId == null || !clientIds.has(clientId)) {
          skippedClient++;
          continue;
        }
        if (locationId == null || !plantIds.has(locationId)) {
          skippedPlant++;
          continue;
        }

        const status = mapStatus(r.verifyStatusId);
        if (!status) {
          skippedStatus++;
          continue;
        }

        const computed = computeServiceFeeAmount(
          fee.serviceFeeType,
          fee.serviceFeeValue,
          fee.totalQuantity,
          fee.totalAmount,
        );
        if (
          serviceInvoiceId != null &&
          Math.abs(computed - fee.serviceFeeAmount) > 0.05
        ) {
          feeMismatch.push({
            id: serviceInvoiceId,
            legacy: fee.serviceFeeAmount,
            computed,
          });
        }

        const createdBy = resolveAuditUserId(createdByRaw, userIds);
        if (createdByRaw !== createdBy) defaultedCreatedBy++;
        const updatedBy = resolveAuditUserIdIfTimestamp(
          r.updatedAt,
          updatedByRaw,
          userIds,
        );
        const generatedByRaw = toId(r.invoiceGeneratedBy);
        const generatedBy =
          generatedByRaw != null && userIds.has(generatedByRaw)
            ? generatedByRaw
            : null;
        const generatedAt =
          r.invoiceGeneratedActualDate &&
          r.invoiceGeneratedActualDate !== "null"
            ? r.invoiceGeneratedActualDate
            : null;
        const emailSentByRaw = toId(r.emailSentBy);
        const emailSentBy =
          emailSentByRaw != null && userIds.has(emailSentByRaw)
            ? emailSentByRaw
            : null;
        const emailSentAt =
          r.emailSentAt && r.emailSentAt !== "null" ? r.emailSentAt : null;

        const gstPercent = toNum(r.gstPer) || 18;
        const gstAmount =
          toNum(r.gstAmount) ||
          Math.round(fee.serviceFeeAmount * gstPercent) / 100;
        const grandTotal =
          toNum(r.grandTotal) || fee.serviceFeeAmount + gstAmount;
        const invoiceDate = invoiceDateOnly(r.invoiceDate);
        const gracePeriod = toId(r.gracePeriod);
        const paymentDueDate =
          invoiceDateOnly(r.paymentDueDate) ??
          (invoiceDate != null
            ? addDaysToDateOnly(invoiceDate, gracePeriod ?? 0)
            : null);

        await client.query(UPSERT_SQL, [
          serviceInvoiceId,
          clientId,
          locationId,
          r.fromDate,
          r.toDate,
          mapType(r.typeId),
          asString(r.orderNumber),
          r.orderDate && r.orderDate !== "null" ? r.orderDate : null,
          gracePeriod,
          fee.totalQuantity.toFixed(3),
          fee.totalAmount.toFixed(3),
          fee.serviceFeeType,
          fee.serviceFeeValue.toFixed(4),
          fee.serviceFeeAmount.toFixed(3),
          gstPercent.toFixed(2),
          gstAmount.toFixed(2),
          grandTotal.toFixed(3),
          roundOffString(r.roundOff),
          asString(r.serviceChargeDescription),
          asString(r.invoiceFormat),
          invoiceDate,
          paymentDueDate,
          status,
          generatedAt,
          generatedBy,
          emailSentAt,
          emailSentBy,
          r.createdAt ?? new Date().toISOString(),
          createdBy,
          r.updatedAt,
          updatedBy,
        ]);
        upserted++;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const sourceCount = result.recordset.length;
    console.log(
      `Upserted ${upserted} / ${sourceCount} rows into service_invoices ` +
        `(${skippedClient} skipped missing client, ${skippedPlant} skipped missing plant, ` +
        `${skippedStatus} skipped unknown status, ${skippedUnknownSrt} skipped unknown SRT, ` +
        `${defaultedCreatedBy} defaulted created_by to 1) in ${Date.now() - started}ms.`,
    );

    if (sourceCount > 0 && upserted === 0) {
      console.warn(
        "\n*** WARN: No service invoices upserted. Check that seed:clients and seed:plant-locations ran first, and MSSQL has rows. ***\n",
      );
    }

    if (mixedSkipped.length > 0) {
      console.warn(
        `\n*** WARN: Skipped ${mixedSkipped.length} Mixed (SRT 37) service invoice row(s) ***`,
      );
      console.warn(`Mixed SRT 37 ids: ${mixedSkipped.join(", ")}`);
    } else {
      console.log("No Mixed (SRT 37) rows found.");
    }

    if (feeMismatch.length > 0) {
      const sample = feeMismatch.slice(0, 20);
      console.warn(
        `Fee amount mismatches vs recomputed formula: ${feeMismatch.length} (showing up to 20)`,
      );
      console.table(sample);
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

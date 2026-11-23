import pg from "pg";
import { env } from "../../env.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { upsertBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";

// Online Instamojo attempts from legacy tbl_Data_OnlinePaymentRequestLog.
const SOURCE_SQL = `
SELECT
  id                                                    AS id,
  BidderCompId                                          AS bidderId,
  SubscriptionTypeId                                    AS subscriptionTypeId,
  PaymentURL                                            AS paymentUrl,
  PaymentRequestTrnId                                   AS merchantTxnId,
  PaymentRequestId                                      AS orderId,
  PaymentStatus                                         AS paymentStatus,
  CONVERT(varchar(33), CreatedOn, 126)                  AS createdAt
FROM tbl_Data_OnlinePaymentRequestLog
ORDER BY id
`;

const HEAD_SQL = `
INSERT INTO subscription_payment_requests (
  id, bidder_id, subscription_type_id,
  merchant_txn_id, order_id, payment_url,
  amount, status, message, instamojo_payment_id, subscription_id,
  created_at, updated_at
)`;

const TAIL_SQL = `
ON CONFLICT (id) DO UPDATE SET
  bidder_id = EXCLUDED.bidder_id,
  subscription_type_id = EXCLUDED.subscription_type_id,
  merchant_txn_id = EXCLUDED.merchant_txn_id,
  order_id = EXCLUDED.order_id,
  payment_url = EXCLUDED.payment_url,
  amount = EXCLUDED.amount,
  status = EXCLUDED.status,
  created_at = EXCLUDED.created_at
`;

type SourceRow = {
  id: string | number;
  bidderId: number | null;
  subscriptionTypeId: number | null;
  paymentUrl: string | null;
  merchantTxnId: string | null;
  orderId: string | null;
  paymentStatus: string | null;
  createdAt: string | null;
};

function toIntOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asString(v: string | null | undefined, max: number): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;
  return t.length > max ? t.slice(0, max) : t;
}

function normalizeStatus(raw: string | null): "requested" | "completed" | "failed" {
  const s = (raw ?? "").trim().toLowerCase();
  if (
    s.includes("complete") ||
    s.includes("success") ||
    s === "paid" ||
    s === "credit"
  ) {
    return "completed";
  }
  if (
    s.includes("fail") ||
    s.includes("cancel") ||
    s.includes("reject") ||
    s.includes("error")
  ) {
    return "failed";
  }
  return "requested";
}

/** Legacy NULL/0 subscription type → placeholder id 0. */
function coerceSubscriptionTypeId(
  v: string | number | null | undefined,
): number {
  const n = toIntOrNull(v);
  return n == null || n <= 0 ? 0 : n;
}

async function ensureLegacyPlaceholders(
  client: pg.PoolClient,
): Promise<void> {
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
      `Pulled ${result.recordset.length} online payment request rows from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    // Need a client for ensureLegacyPlaceholders and ID lookups before batching
    const setupClient = await pgPool.connect();
    let bidderIds: Set<number>;
    let typeIds: Set<number>;
    try {
      await ensureLegacyPlaceholders(setupClient);
      [bidderIds, typeIds] = await Promise.all([
        setupClient.query<{ id: number }>("SELECT id FROM bidders").then((r) => new Set(r.rows.map((x) => x.id))),
        setupClient.query<{ id: number }>("SELECT id FROM subscription_types").then((r) => new Set(r.rows.map((x) => x.id))),
      ]);
    } finally {
      setupClient.release();
    }

    // Build rows in-memory (13 params each)
    const rows: unknown[][] = [];
    let skippedNullId = 0;
    let skippedMissingBidder = 0;
    let skippedMissingType = 0;
    const seenTxn = new Set<string>();

    for (const r of result.recordset) {
      const id = toIntOrNull(r.id);
      const bidderId = toIntOrNull(r.bidderId) ?? 0;
      const subscriptionTypeId = coerceSubscriptionTypeId(r.subscriptionTypeId);

      if (id == null) { skippedNullId++; continue; }
      if (!bidderIds.has(bidderId)) { skippedMissingBidder++; continue; }
      if (!typeIds.has(subscriptionTypeId)) { skippedMissingType++; continue; }

      let merchantTxnId = asString(r.merchantTxnId, 100) ?? `legacy_${id}`;
      if (seenTxn.has(merchantTxnId)) merchantTxnId = `legacy_${id}`;
      seenTxn.add(merchantTxnId);

      rows.push([
        id,
        bidderId,
        subscriptionTypeId,
        merchantTxnId,
        asString(r.orderId, 100),
        asString(r.paymentUrl, 1000),
        "0",
        normalizeStatus(r.paymentStatus),
        null,
        null,
        null,
        r.createdAt ?? new Date().toISOString(),
        null,
      ]);
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await upsertBatched(client, "subscription_payment_requests", HEAD_SQL, TAIL_SQL, rows);
      await client.query(
        `SELECT setval(
          pg_get_serial_sequence('subscription_payment_requests', 'id'),
          COALESCE((SELECT MAX(id) FROM subscription_payment_requests), 1)
        )`,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Upserted ${rows.length} subscription_payment_requests ` +
        `(${skippedNullId} skipped: null id, ` +
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

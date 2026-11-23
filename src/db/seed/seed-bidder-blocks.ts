import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { upsertBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";

const SOURCE_SQL = `
SELECT
  ID            AS id,
  ClientId      AS clientId,
  BidderCompId  AS bidderId,
  IsBlocked     AS isBlocked,
  Reason        AS reason,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy     AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy     AS updatedBy
FROM tbl_Data_Client_BidderComp_BlockLog
`;

const HEAD_SQL = `
INSERT INTO bidder_block_logs (
  id, client_id, bidder_id, is_blocked, reason,
  created_at, created_by, updated_at, updated_by
)`;

const TAIL_SQL = `
ON CONFLICT (id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  bidder_id = EXCLUDED.bidder_id,
  is_blocked = EXCLUDED.is_blocked,
  reason = EXCLUDED.reason,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
  id: number;
  clientId: number;
  bidderId: number;
  isBlocked: boolean;
  reason: string | null;
  createdAt: string | null;
  createdBy: number;
  updatedAt: string | null;
  updatedBy: number | null;
};

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} bidder block-log rows from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [clientRows, bidderRows, userRows] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM clients"),
      pgPool.query<{ id: number }>("SELECT id FROM bidders"),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
    ]);
    const validClientIds = new Set(clientRows.rows.map((r) => r.id));
    const validBidderIds = new Set(bidderRows.rows.map((r) => r.id));
    const validUserIds = new Set(userRows.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);

    // Build rows in-memory (9 params each)
    const rows: unknown[][] = [];
    let skippedMissingClient = 0;
    let skippedMissingBidder = 0;
    let defaultedCreatedBy = 0;
    let defaultedUpdatedBy = 0;

    for (const r of result.recordset) {
      if (!validClientIds.has(r.clientId)) { skippedMissingClient++; continue; }
      if (!validBidderIds.has(r.bidderId)) { skippedMissingBidder++; continue; }

      const createdBy = resolveAuditUserId(r.createdBy, validUserIds);
      if (r.createdBy !== createdBy) defaultedCreatedBy++;
      const updatedBy = resolveAuditUserIdIfTimestamp(r.updatedAt, r.updatedBy, validUserIds);
      if (r.updatedAt != null && (r.updatedBy == null || r.updatedBy !== updatedBy)) defaultedUpdatedBy++;

      rows.push([
        r.id,
        r.clientId,
        r.bidderId,
        Boolean(r.isBlocked),
        r.reason,
        r.createdAt ?? new Date().toISOString(),
        createdBy,
        r.updatedAt,
        updatedBy,
      ]);
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await upsertBatched(client, "bidder_block_logs", HEAD_SQL, TAIL_SQL, rows);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Upserted ${rows.length} rows into bidder_block_logs ` +
        `(${skippedMissingClient} skipped: client not in Postgres, ` +
        `${skippedMissingBidder} skipped: bidder not in Postgres, ` +
        `defaulted created_by to 1 on ${defaultedCreatedBy} rows, ` +
        `defaulted updated_by to 1 on ${defaultedUpdatedBy} rows) ` +
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

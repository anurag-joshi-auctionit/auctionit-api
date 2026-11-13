import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import { upsertBatched } from "./batch-write.js";

/** MSSQL `tbl_Data_AuctionLiftingLot` → Postgres `lifting_client_logs`. */
const SOURCE_SQL = `
SELECT
  AuctionLoftingLotId AS id,
  CONVERT(varchar(33), LiftingEntryDate, 126) AS liftingEntryDate,
  CONVERT(varchar(10), LiftingDate, 23) AS liftingDate,
  ClientId AS clientId,
  AuctionId AS auctionId,
  LotId AS lotId,
  ItemId AS itemId,
  Qty AS qty,
  LiftingStatus AS liftingStatus,
  LTRIM(RTRIM(ODN)) AS odn,
  CreatedBy AS createdBy,
  CONVERT(varchar(10), CreatedOn, 23) AS createdOn,
  RFDL_Id AS rfdlId,
  RFDL_ReasonDescription AS rfdlReasonDescription
FROM tbl_Data_AuctionLiftingLot
ORDER BY AuctionLoftingLotId
`;

const UPSERT_HEAD = `
INSERT INTO lifting_client_logs (
  id, lifting_entry_date, lifting_date, client_id, auction_id, lot_id,
  item_id, qty, lifting_status, odn, created_by, created_on,
  rfdl_id, rfdl_reason_description
)
`;

const UPSERT_TAIL = `
ON CONFLICT (id) DO UPDATE SET
  lifting_entry_date = EXCLUDED.lifting_entry_date,
  lifting_date = EXCLUDED.lifting_date,
  client_id = EXCLUDED.client_id,
  auction_id = EXCLUDED.auction_id,
  lot_id = EXCLUDED.lot_id,
  item_id = EXCLUDED.item_id,
  qty = EXCLUDED.qty,
  lifting_status = EXCLUDED.lifting_status,
  odn = EXCLUDED.odn,
  created_by = EXCLUDED.created_by,
  created_on = EXCLUDED.created_on,
  rfdl_id = EXCLUDED.rfdl_id,
  rfdl_reason_description = EXCLUDED.rfdl_reason_description
`;

function asString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
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

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} lifting client log rows from MSSQL.`,
    );

    const [lotIds, auctionIds, clientIds, userIds, itemIds] = await Promise.all(
      [
        pgPool.query<{ id: number }>("SELECT id FROM auction_lots"),
        pgPool.query<{ id: number }>("SELECT auction_id AS id FROM auctions"),
        pgPool.query<{ id: number }>("SELECT id FROM clients"),
        pgPool.query<{ id: number }>("SELECT id FROM users"),
        pgPool.query<{ id: number }>("SELECT id FROM items"),
      ],
    );

    const validLotIds = new Set(lotIds.rows.map((r) => r.id));
    const validAuctionIds = new Set(auctionIds.rows.map((r) => r.id));
    const validClientIds = new Set(clientIds.rows.map((r) => r.id));
    const validUserIds = new Set(userIds.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);
    const validItemIds = new Set(itemIds.rows.map((r) => r.id));

    const client = await pgPool.connect();
    let upserted = 0;
    let skippedMissingLot = 0;
    let skippedMissingAuction = 0;
    let skippedMissingClient = 0;
    let skippedMissingRequired = 0;

    try {
      await client.query("BEGIN");

      const rows: unknown[][] = [];
      for (const r of result.recordset) {
        const lotId = intOrNull(r.lotId);
        const auctionId = intOrNull(r.auctionId);
        const clientId = intOrNull(r.clientId);
        const id = intOrNull(r.id);

        if (id == null || lotId == null || auctionId == null || clientId == null) {
          skippedMissingRequired++;
          continue;
        }
        if (!validLotIds.has(lotId)) {
          skippedMissingLot++;
          continue;
        }
        if (!validAuctionIds.has(auctionId)) {
          skippedMissingAuction++;
          continue;
        }
        if (!validClientIds.has(clientId)) {
          skippedMissingClient++;
          continue;
        }

        const createdBy = resolveAuditUserId(
          intOrNull(r.createdBy),
          validUserIds,
        );

        const itemIdRaw = intOrNull(r.itemId);
        const itemId =
          itemIdRaw != null && validItemIds.has(itemIdRaw) ? itemIdRaw : null;

        const qty = numericOrNull(r.qty);
        const liftingStatus = intOrNull(r.liftingStatus);
        const createdOn = asString(r.createdOn);
        if (qty == null || liftingStatus == null || !createdOn) {
          skippedMissingRequired++;
          continue;
        }

        rows.push([
          id,
          r.liftingEntryDate,
          asString(r.liftingDate),
          clientId,
          auctionId,
          lotId,
          itemId,
          qty,
          liftingStatus,
          asString(r.odn),
          createdBy,
          createdOn,
          intOrNull(r.rfdlId),
          asString(r.rfdlReasonDescription),
        ]);
        upserted++;
      }
      await upsertBatched(client, "lifting_client_logs", UPSERT_HEAD, UPSERT_TAIL, rows);

      // Keep bigserial sequence ahead of migrated ids.
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('lifting_client_logs', 'id'),
          COALESCE((SELECT MAX(id) FROM lifting_client_logs), 1),
          true
        )
      `);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Upserted ${upserted} lifting_client_logs rows ` +
        `(${skippedMissingLot} skipped: lot not in Postgres, ` +
        `${skippedMissingAuction} skipped: auction not in Postgres, ` +
        `${skippedMissingClient} skipped: client not in Postgres, ` +
        `${skippedMissingRequired} skipped: missing required field) ` +
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

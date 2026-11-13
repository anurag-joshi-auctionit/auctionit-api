import pg from "pg";
import { env } from "../../env.js";
import { updateBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";

/**
 * Backfill `auction_lots.is_approved` + `reviewed_at` from MSSQL lot items.
 * PG `auction_lot_items` has no approval columns; MSSQL
 * `tbl_Data_Auction_Lot_Items` is the source of truth.
 */
const SOURCE_SQL = `
SELECT
  LotID AS lotId,
  CAST(MIN(CAST(COALESCE(IsApproved, 0) AS int)) AS bit) AS isApproved,
  CONVERT(varchar(33), MIN(ApprovalDate), 126) AS reviewedAt
FROM tbl_Data_Auction_Lot_Items
GROUP BY LotID
ORDER BY LotID
`;

const UPDATE_SQL = `
UPDATE auction_lots l
SET
  is_approved = v.is_approved,
  reviewed_at = v.reviewed_at
FROM json_to_recordset($1::json)
  AS v(id int, is_approved boolean, reviewed_at timestamptz)
WHERE l.id = v.id
`;

function intOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query(SOURCE_SQL);
    console.log(
      `Pulled approval aggregates for ${result.recordset.length} lots from MSSQL.`,
    );

    const lotIds = await pgPool.query<{ id: number }>(
      "SELECT id FROM auction_lots",
    );
    const validLotIds = new Set(lotIds.rows.map((r) => r.id));

    if (dryRun) {
      const matched = result.recordset.filter((r: { lotId: number }) =>
        validLotIds.has(Number(r.lotId)),
      );
      console.log("Dry run — no rows updated.");
      console.log(
        `Would update ${matched.length} auction_lots (${result.recordset.length - matched.length} MSSQL lots missing in PG).`,
      );
      console.table(matched.slice(0, 5));
      return;
    }

    const client = await pgPool.connect();
    let updated = 0;
    let skipped = 0;

    try {
      await client.query("BEGIN");

      const rows: object[] = [];
      for (const r of result.recordset) {
        const lotId = intOrNull(r.lotId);
        if (lotId == null || !validLotIds.has(lotId)) {
          skipped++;
          continue;
        }

        const isApproved =
          r.isApproved == null ? null : Boolean(r.isApproved);
        const reviewedAt =
          r.reviewedAt == null || String(r.reviewedAt).trim() === ""
            ? null
            : String(r.reviewedAt);

        rows.push({ id: lotId, is_approved: isApproved, reviewed_at: reviewedAt });
        updated++;
      }
      await updateBatched(client, "auction_lots approval", UPDATE_SQL, rows);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Backfilled is_approved/reviewed_at on ${updated} auction_lots ` +
        `(${skipped} skipped: lot not in Postgres) ` +
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

import pg from "pg";
import { env } from "../../env.js";
import { connectMssql } from "./mssql.js";

/**
 * Seeds `clients.bidders` from legacy tbl_Config_Client_BidderComp_Map,
 * then backfills material arrays from Postgres participation data:
 *   - clients.materials ← distinct items.material_id by client
 *   - bidders.materials ← lot-map → lot items → material_id
 */

const SOURCE_SQL = `
SELECT
  ClientId AS clientId,
  BidderCompId AS bidderId
FROM tbl_Config_Client_BidderComp_Map
WHERE ISNULL(IsActive, 1) = 1
`;

type MapRow = {
  clientId: number;
  bidderId: number;
};

function uniqueSorted(ids: Iterable<number>): number[] {
  return [...new Set(ids)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  let mapUpdated = 0;
  let mapSkipped = 0;
  let clientMaterialsUpdated = 0;
  let bidderMaterialsUpdated = 0;

  try {
    const result = await mssqlPool.request().query<MapRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} active client–bidder map rows from MSSQL.`,
    );

    const [clientRows, bidderRows] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM clients"),
      pgPool.query<{ id: number }>("SELECT id FROM bidders"),
    ]);
    const validClientIds = new Set(clientRows.rows.map((r) => r.id));
    const validBidderIds = new Set(bidderRows.rows.map((r) => r.id));

    const byClient = new Map<number, Set<number>>();
    for (const row of result.recordset) {
      const clientId = Number(row.clientId);
      const bidderId = Number(row.bidderId);
      if (!validClientIds.has(clientId) || !validBidderIds.has(bidderId)) {
        mapSkipped += 1;
        continue;
      }
      let set = byClient.get(clientId);
      if (!set) {
        set = new Set();
        byClient.set(clientId, set);
      }
      set.add(bidderId);
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");

      for (const [clientId, bidderSet] of byClient) {
        const bidderIds = uniqueSorted(bidderSet);
        if (bidderIds.length === 0) continue;
        const res = await client.query(
          `
          UPDATE clients
          SET bidders = (
            SELECT COALESCE(
              ARRAY(
                SELECT DISTINCT x
                FROM unnest(COALESCE(bidders, '{}'::int[]) || $1::int[]) AS t(x)
                ORDER BY x
              ),
              '{}'::int[]
            )
          ),
          updated_at = COALESCE(updated_at, now())
          WHERE id = $2
            AND NOT (COALESCE(bidders, '{}'::int[]) @> $1::int[])
          `,
          [bidderIds, clientId],
        );
        mapUpdated += res.rowCount ?? 0;
      }

      const clientMatRes = await client.query(`
        UPDATE clients c
        SET materials = sub.material_ids,
            updated_at = COALESCE(c.updated_at, now())
        FROM (
          SELECT
            i.client_id,
            ARRAY(
              SELECT DISTINCT m
              FROM unnest(
                COALESCE(c0.materials, '{}'::int[])
                || COALESCE(
                  (
                    SELECT array_agg(DISTINCT i2.material_id)
                    FROM items i2
                    WHERE i2.client_id = i.client_id
                      AND i2.material_id IS NOT NULL
                  ),
                  '{}'::int[]
                )
              ) AS m
              ORDER BY m
            ) AS material_ids
          FROM items i
          JOIN clients c0 ON c0.id = i.client_id
          WHERE i.material_id IS NOT NULL
          GROUP BY i.client_id, c0.materials
        ) sub
        WHERE c.id = sub.client_id
          AND c.materials IS DISTINCT FROM sub.material_ids
      `);
      clientMaterialsUpdated = clientMatRes.rowCount ?? 0;

      const bidderMatRes = await client.query(`
        UPDATE bidders b
        SET materials = sub.material_ids,
            updated_at = COALESCE(b.updated_at, now())
        FROM (
          SELECT
            m.bidder_id,
            ARRAY(
              SELECT DISTINCT x
              FROM unnest(
                COALESCE(b0.materials, '{}'::int[])
                || COALESCE(
                  array_agg(DISTINCT i.material_id)
                    FILTER (WHERE i.material_id IS NOT NULL),
                  '{}'::int[]
                )
              ) AS t(x)
              ORDER BY x
            ) AS material_ids
          FROM auction_lot_bidder_maps m
          JOIN auction_lot_items ali
            ON ali.lot_id = m.lot_id
           AND ali.is_active = true
          JOIN items i ON i.id = ali.item_id
          JOIN bidders b0 ON b0.id = m.bidder_id
          WHERE m.is_active = true
            AND m.lot_id IS NOT NULL
          GROUP BY m.bidder_id, b0.materials
        ) sub
        WHERE b.id = sub.bidder_id
          AND b.materials IS DISTINCT FROM sub.material_ids
      `);
      bidderMaterialsUpdated = bidderMatRes.rowCount ?? 0;

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `client.bidders: updated=${mapUpdated} skipped=${mapSkipped}; ` +
        `clients.materials backfill=${clientMaterialsUpdated}; ` +
        `bidders.materials backfill=${bidderMaterialsUpdated}; ` +
        `${Date.now() - started}ms`,
    );
    console.log(
      mapSkipped > 0
        ? `SEED_OUTCOME warn skipped=${mapSkipped}`
        : "SEED_OUTCOME ok skipped=0",
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

import pg from "pg";
import { env } from "../../env.js";

/**
 * Postgres-only backfill of standing material arrays:
 *   - clients.materials ← distinct items.material_id by client
 *   - bidders.materials ← active lot-bidder maps → lot items → material_id
 *
 * Idempotent set-union; does not remove existing IDs.
 * Use when historical attaches/items predate auto-union on write paths.
 *
 *   pnpm seed:backfill-standing-materials
 */

async function main() {
  const started = Date.now();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pgPool.connect();

  let clientMaterialsUpdated = 0;
  let bidderMaterialsUpdated = 0;

  try {
    await client.query("BEGIN");

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

    console.log(
      `clients.materials backfill=${clientMaterialsUpdated}; ` +
        `bidders.materials backfill=${bidderMaterialsUpdated}; ` +
        `${Date.now() - started}ms`,
    );
    console.log("SEED_OUTCOME ok");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

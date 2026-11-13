import { sql, type SQL } from "drizzle-orm";

/** Shared UPDATE that rebuilds `auction_lots.latest_lifted_*` for one lot. */
export function syncLatestLiftedForLotSql(lotId: number): SQL {
  return sql`
    UPDATE auction_lots AS al
    SET
      latest_lifted_status = latest.lifting_status,
      latest_lifted_date = latest.lifting_date,
      latest_lifted_qty = qty_agg.total_qty
    FROM (
      SELECT client_id, lot_id, lifting_status, lifting_date
      FROM (
        SELECT
          client_id,
          lot_id,
          lifting_status,
          lifting_date,
          ROW_NUMBER() OVER (PARTITION BY client_id, lot_id ORDER BY id DESC) AS rn
        FROM lifting_client_logs
        WHERE lot_id = ${lotId}
      ) t
      WHERE rn = 1
    ) latest,
    (
      SELECT
        client_id,
        lot_id,
        COALESCE(SUM(CAST(qty AS decimal(38, 3))), 0) AS total_qty
      FROM lifting_client_logs
      WHERE lot_id = ${lotId}
      GROUP BY client_id, lot_id
    ) qty_agg
    WHERE al.id = latest.lot_id
      AND al.client_id = latest.client_id
      AND qty_agg.client_id = latest.client_id
      AND qty_agg.lot_id = latest.lot_id
  `;
}

/**
 * Bulk backfill for all lots that have lifting_client_logs rows.
 * Used by `seed/backfill-latest-lifted.ts` (raw `pg` client).
 */
export const BACKFILL_LATEST_LIFTED_SQL = `
UPDATE auction_lots AS al
SET
  latest_lifted_status = latest.lifting_status,
  latest_lifted_date = latest.lifting_date,
  latest_lifted_qty = qty_agg.total_qty
FROM (
  SELECT client_id, lot_id, lifting_status, lifting_date
  FROM (
    SELECT
      client_id,
      lot_id,
      lifting_status,
      lifting_date,
      ROW_NUMBER() OVER (PARTITION BY client_id, lot_id ORDER BY id DESC) AS rn
    FROM lifting_client_logs
  ) t
  WHERE rn = 1
) latest
INNER JOIN (
  SELECT
    client_id,
    lot_id,
    COALESCE(SUM(CAST(qty AS decimal(38, 3))), 0) AS total_qty
  FROM lifting_client_logs
  GROUP BY client_id, lot_id
) qty_agg
  ON qty_agg.client_id = latest.client_id
 AND qty_agg.lot_id = latest.lot_id
WHERE al.id = latest.lot_id
  AND al.client_id = latest.client_id
`;

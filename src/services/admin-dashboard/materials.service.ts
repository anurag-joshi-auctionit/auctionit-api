import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { IsoDateRange } from "../../lib/dashboard/period.js";
import { num } from "./helpers.js";

export type TopMaterialRow = {
  materialId: number;
  label: string;
  quantity: number;
};

export type MaterialsDashboard = {
  rows: TopMaterialRow[];
};

/** Top 5 materials by quantity sold in the date range. */
export async function getMaterials(
  range: IsoDateRange,
): Promise<MaterialsDashboard> {
  const topRes = await db.execute<{
    material_id: number;
    label: string;
    quantity: number;
  }>(sql`
    SELECT
      m.id AS material_id,
      m.label,
      COALESCE(SUM(ali.quantity), 0) AS quantity
    FROM auction_lot_items ali
    INNER JOIN auction_lots l ON l.id = ali.lot_id AND l.is_active = true
    INNER JOIN items i ON i.id = ali.item_id
    INNER JOIN materials m ON m.id = i.material_id
    INNER JOIN auctions a ON a.auction_id = ali.auction_id
    WHERE ali.is_active = true
      AND i.material_id IS NOT NULL
      AND l.winner_bidder_id IS NOT NULL
      AND a.is_active = true
      AND a.auction_date::date >= CAST(${range.from} AS date)
      AND a.auction_date::date <= CAST(${range.to} AS date)
    GROUP BY m.id, m.label
    ORDER BY quantity DESC
    LIMIT 5
  `);

  return {
    rows: topRes.rows.map((r) => ({
      materialId: num(r.material_id),
      label: r.label,
      quantity: num(r.quantity),
    })),
  };
}

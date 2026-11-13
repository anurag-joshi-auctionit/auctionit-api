import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { PMT_UOM_SQL } from "../lib/client-dashboard/pmt-uom.js";
import {
  resolveMaterialSeriesGrain,
  type IsoDateRange,
  type MaterialSeriesGrain,
} from "../lib/dashboard/period.js";
import { parseQty } from "../lib/qty.js";

export type BidderDashboardClientOption = {
  clientId: number;
  companyName: string;
};

export type BidderLiftingFilters = {
  plants: Array<{ id: number; name: string }>;
  items: Array<{ id: number; name: string }>;
};

export type BidderLiftingSellerRow = {
  clientId: number;
  clientName: string | null;
  materialApprovedMt: number;
  materialLiftedMt: number;
  materialPendingMt: number;
  approvedValue: number;
  liftedValue: number;
};

export type BidderLiftingSeriesPoint = {
  period: string;
  periodLabel: string;
  approvedQty: number;
  liftedQty: number;
  approvedAmount: number;
  liftedAmount: number;
};

export type BidderLiftingDetails = {
  summary: {
    materialApprovedMt: number;
    materialLiftedMt: number;
    materialPendingMt: number;
    approvedValue: number;
    liftedValue: number;
  };
  rows: BidderLiftingSellerRow[];
  series: {
    grain: MaterialSeriesGrain;
    points: BidderLiftingSeriesPoint[];
  };
};

function num(v: string | number | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatBucketLabel(
  periodIso: string,
  grain: MaterialSeriesGrain,
): string {
  const [y, m] = periodIso.split("-");
  const year = y ?? "";
  const monthNum = Number(m);
  if (grain === "year") return year;
  if (grain === "quarter") {
    const q = Math.floor((monthNum - 1) / 3) + 1;
    return `Q${q}-${year.slice(2)}`;
  }
  return `${MONTHS_SHORT[monthNum - 1] ?? m}-${year.slice(2)}`;
}

function eligibleLotFilters(opts: {
  bidderId: number;
  range: IsoDateRange;
  clientId?: number;
  plantLocationId?: number;
  itemId?: number;
}) {
  const clientFilter =
    opts.clientId != null ? sql`AND a.client_id = ${opts.clientId}` : sql``;
  const plantFilter =
    opts.plantLocationId != null
      ? sql`AND l.plant_location_id = ${opts.plantLocationId}`
      : sql``;
  const itemFilter =
    opts.itemId != null
      ? sql`AND EXISTS (
          SELECT 1
          FROM auction_lot_items ali
          WHERE ali.lot_id = l.id
            AND ali.is_active = true
            AND ali.item_id = ${opts.itemId}
        )`
      : sql``;

  return { clientFilter, plantFilter, itemFilter };
}

class BidderDashboardService {
  async listClients(
    bidderId: number,
    range: IsoDateRange,
  ): Promise<BidderDashboardClientOption[]> {
    const res = await db.execute<{
      client_id: number;
      company_name: string | null;
    }>(sql`
      SELECT DISTINCT a.client_id, COALESCE(c.company_name, '') AS company_name
      FROM auction_lots l
      INNER JOIN auctions a ON a.auction_id = l.auction_id
      INNER JOIN uoms u ON u.id = l.uom_id
      LEFT JOIN clients c ON c.id = a.client_id
      WHERE l.winner_bidder_id = ${bidderId}
        AND a.status = 'closed'
        AND a.is_active = true
        AND l.is_active = true
        AND l.is_approved = true
        AND l.winning_amount IS NOT NULL
        AND l.winner_bidder_id IS NOT NULL
        AND a.auction_date::date >= CAST(${range.from} AS date)
        AND a.auction_date::date <= CAST(${range.to} AS date)
        AND ${sql.raw(PMT_UOM_SQL)}
      ORDER BY company_name ASC, a.client_id ASC
    `);

    return res.rows.map((r) => ({
      clientId: r.client_id,
      companyName: r.company_name || `Client #${r.client_id}`,
    }));
  }

  async getLiftingFilters(
    bidderId: number,
    range: IsoDateRange,
    clientId?: number,
  ): Promise<BidderLiftingFilters> {
    const clientFilter =
      clientId != null ? sql`AND a.client_id = ${clientId}` : sql``;

    const [plantsRes, itemsRes] = await Promise.all([
      db.execute<{ id: number; name: string }>(sql`
        SELECT DISTINCT pl.id, COALESCE(pl.name, '') AS name
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        INNER JOIN uoms u ON u.id = l.uom_id
        INNER JOIN plant_locations pl ON pl.id = l.plant_location_id
        WHERE l.winner_bidder_id = ${bidderId}
          AND a.status = 'closed'
          AND a.is_active = true
          AND l.is_active = true
          AND l.is_approved = true
          AND l.winning_amount IS NOT NULL
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
          AND ${sql.raw(PMT_UOM_SQL)}
          ${clientFilter}
        ORDER BY name ASC, pl.id ASC
      `),
      db.execute<{ id: number; name: string }>(sql`
        SELECT DISTINCT i.id, COALESCE(i.name, '') AS name
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        INNER JOIN uoms u ON u.id = l.uom_id
        INNER JOIN auction_lot_items ali
          ON ali.lot_id = l.id AND ali.is_active = true
        INNER JOIN items i ON i.id = ali.item_id
        WHERE l.winner_bidder_id = ${bidderId}
          AND a.status = 'closed'
          AND a.is_active = true
          AND l.is_active = true
          AND l.is_approved = true
          AND l.winning_amount IS NOT NULL
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
          AND ${sql.raw(PMT_UOM_SQL)}
          ${clientFilter}
        ORDER BY name ASC, i.id ASC
      `),
    ]);

    return {
      plants: plantsRes.rows.map((r) => ({ id: r.id, name: r.name })),
      items: itemsRes.rows.map((r) => ({ id: r.id, name: r.name })),
    };
  }

  async getLiftingDetails(
    bidderId: number,
    range: IsoDateRange,
    filters: {
      clientId?: number;
      plantLocationId?: number;
      itemId?: number;
    } = {},
  ): Promise<BidderLiftingDetails> {
    const { clientFilter, plantFilter, itemFilter } = eligibleLotFilters({
      bidderId,
      range,
      ...filters,
    });

    const grain = resolveMaterialSeriesGrain(range);
    const truncUnit = sql.raw(`'${grain}'`);

    const [sellersRes, seriesRes] = await Promise.all([
      db.execute<{
        client_id: number;
        client_name: string | null;
        approved_qty: string | number;
        lifted_qty: string | number;
        approved_amount: string | number;
        lifted_amount: string | number;
      }>(sql`
        WITH eligible_lots AS (
          SELECT
            l.id AS lot_id,
            a.client_id,
            c.company_name AS client_name,
            CAST(l.quantity AS decimal(38, 3)) AS approved_qty,
            CAST(l.winning_amount AS decimal(38, 6)) AS unit_price,
            CAST(l.quantity AS decimal(38, 6))
              * CAST(l.winning_amount AS decimal(38, 6)) AS approved_amount
          FROM auction_lots l
          INNER JOIN auctions a ON a.auction_id = l.auction_id
          INNER JOIN uoms u ON u.id = l.uom_id
          LEFT JOIN clients c ON c.id = a.client_id
          WHERE l.winner_bidder_id = ${bidderId}
            AND a.status = 'closed'
            AND a.is_active = true
            AND l.is_active = true
            AND l.is_approved = true
            AND l.winning_amount IS NOT NULL
            AND l.winner_bidder_id IS NOT NULL
            AND a.auction_date::date >= CAST(${range.from} AS date)
            AND a.auction_date::date <= CAST(${range.to} AS date)
            AND ${sql.raw(PMT_UOM_SQL)}
            ${clientFilter}
            ${plantFilter}
            ${itemFilter}
        ),
        lift_by_lot AS (
          SELECT
            el.lot_id,
            COALESCE(SUM(CAST(ll.qty AS decimal(38, 3))), 0) AS lifted_qty,
            COALESCE(SUM(
              CAST(ll.qty AS decimal(38, 6)) * el.unit_price
            ), 0) AS lifted_amount
          FROM eligible_lots el
          INNER JOIN lifting_client_logs ll
            ON ll.lot_id = el.lot_id AND ll.client_id = el.client_id
          GROUP BY el.lot_id
        )
        SELECT
          el.client_id,
          MAX(el.client_name) AS client_name,
          COALESCE(SUM(el.approved_qty), 0) AS approved_qty,
          COALESCE(SUM(COALESCE(lb.lifted_qty, 0)), 0) AS lifted_qty,
          COALESCE(SUM(el.approved_amount), 0) AS approved_amount,
          COALESCE(SUM(COALESCE(lb.lifted_amount, 0)), 0) AS lifted_amount
        FROM eligible_lots el
        LEFT JOIN lift_by_lot lb ON lb.lot_id = el.lot_id
        GROUP BY el.client_id
        ORDER BY MAX(el.client_name) ASC NULLS LAST, el.client_id ASC
      `),
      db.execute<{
        period: string;
        approved_qty: string | number;
        lifted_qty: string | number;
        approved_amount: string | number;
        lifted_amount: string | number;
      }>(sql`
        WITH eligible_lots AS (
          SELECT
            l.id AS lot_id,
            a.client_id,
            date_trunc(${truncUnit}, a.auction_date)::date AS bucket_start,
            CAST(l.quantity AS decimal(38, 3)) AS approved_qty,
            CAST(l.winning_amount AS decimal(38, 6)) AS unit_price,
            CAST(l.quantity AS decimal(38, 6))
              * CAST(l.winning_amount AS decimal(38, 6)) AS approved_amount
          FROM auction_lots l
          INNER JOIN auctions a ON a.auction_id = l.auction_id
          INNER JOIN uoms u ON u.id = l.uom_id
          WHERE l.winner_bidder_id = ${bidderId}
            AND a.status = 'closed'
            AND a.is_active = true
            AND l.is_active = true
            AND l.is_approved = true
            AND l.winning_amount IS NOT NULL
            AND l.winner_bidder_id IS NOT NULL
            AND a.auction_date::date >= CAST(${range.from} AS date)
            AND a.auction_date::date <= CAST(${range.to} AS date)
            AND ${sql.raw(PMT_UOM_SQL)}
            ${clientFilter}
            ${plantFilter}
            ${itemFilter}
        ),
        lift_by_lot AS (
          SELECT
            el.lot_id,
            COALESCE(SUM(CAST(ll.qty AS decimal(38, 3))), 0) AS lifted_qty,
            COALESCE(SUM(
              CAST(ll.qty AS decimal(38, 6)) * el.unit_price
            ), 0) AS lifted_amount
          FROM eligible_lots el
          INNER JOIN lifting_client_logs ll
            ON ll.lot_id = el.lot_id AND ll.client_id = el.client_id
          GROUP BY el.lot_id
        )
        SELECT
          to_char(el.bucket_start, 'YYYY-MM-DD') AS period,
          COALESCE(SUM(el.approved_qty), 0) AS approved_qty,
          COALESCE(SUM(COALESCE(lb.lifted_qty, 0)), 0) AS lifted_qty,
          COALESCE(SUM(el.approved_amount), 0) AS approved_amount,
          COALESCE(SUM(COALESCE(lb.lifted_amount, 0)), 0) AS lifted_amount
        FROM eligible_lots el
        LEFT JOIN lift_by_lot lb ON lb.lot_id = el.lot_id
        GROUP BY el.bucket_start
        ORDER BY el.bucket_start ASC
      `),
    ]);

    const rows: BidderLiftingSellerRow[] = sellersRes.rows.map((r) => {
      const approved = parseQty(r.approved_qty);
      const lifted = parseQty(r.lifted_qty);
      return {
        clientId: r.client_id,
        clientName: r.client_name,
        materialApprovedMt: approved,
        materialLiftedMt: lifted,
        materialPendingMt: parseQty(approved - lifted),
        approvedValue: round2(num(r.approved_amount)),
        liftedValue: round2(num(r.lifted_amount)),
      };
    });

    const summary = rows.reduce(
      (acc, row) => ({
        materialApprovedMt: parseQty(
          acc.materialApprovedMt + row.materialApprovedMt,
        ),
        materialLiftedMt: parseQty(acc.materialLiftedMt + row.materialLiftedMt),
        materialPendingMt: parseQty(
          acc.materialPendingMt + row.materialPendingMt,
        ),
        approvedValue: round2(acc.approvedValue + row.approvedValue),
        liftedValue: round2(acc.liftedValue + row.liftedValue),
      }),
      {
        materialApprovedMt: 0,
        materialLiftedMt: 0,
        materialPendingMt: 0,
        approvedValue: 0,
        liftedValue: 0,
      },
    );

    const points: BidderLiftingSeriesPoint[] = seriesRes.rows.map((r) => ({
      period: r.period,
      periodLabel: formatBucketLabel(r.period, grain),
      approvedQty: parseQty(r.approved_qty),
      liftedQty: parseQty(r.lifted_qty),
      approvedAmount: round2(num(r.approved_amount)),
      liftedAmount: round2(num(r.lifted_amount)),
    }));

    return { summary, rows, series: { grain, points } };
  }
}

export const bidderDashboardService = new BidderDashboardService();

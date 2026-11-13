import { ClientDashboardMessages } from "@auctionit/messages/client-dashboard";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { PMT_UOM_SQL } from "../lib/client-dashboard/pmt-uom.js";
import {
  equalLengthPriorPeriod,
  formatDashboardPeriodLabel,
  resolveMaterialSeriesGrain,
  withDelta,
  type IsoDateRange,
  type MaterialSeriesGrain,
  type MetricWithDelta,
} from "../lib/dashboard/period.js";
import { parseQty } from "../lib/qty.js";

export class ClientDashboardAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientDashboardAccessError";
  }
}

export class ClientDashboardNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientDashboardNotFoundError";
  }
}

export type DashboardClientOption = {
  clientId: number;
  companyName: string;
};

export type DashboardAuctionOption = {
  auctionId: number;
  auctionNumber: string | null;
  auctionDate: string | null;
};

export type DelayReasonRow = {
  reason: string;
  lotCount: number;
};

export type DashboardSummary = {
  totalAuctions: MetricWithDelta;
  totalBidQtyMt: MetricWithDelta;
  totalBidValueCr: MetricWithDelta;
  attachedBidders: MetricWithDelta;
  participatedBidders: MetricWithDelta;
  newBidders: MetricWithDelta;
  auctionsBidderLt5: MetricWithDelta;
  auctionsBidder5To10: MetricWithDelta;
  auctionsBidderGt10: MetricWithDelta;
  totalApprovedQtyMt: MetricWithDelta;
  totalLiftedQtyMt: MetricWithDelta;
  delayReasons: DelayReasonRow[];
  currentPeriodLabel: string;
  previousPeriodLabel: string;
};

export type {
  MaterialSeriesGrain,
} from "../lib/dashboard/period.js";

export type MaterialSeriesPoint = {
  period: string;
  periodLabel: string;
  offeredQty: number;
  bidQty: number;
  approvedQty: number;
  offeredAmountLakh: number;
  bidAmountLakh: number;
  approvedAmountLakh: number;
};

export type MaterialSeriesResponse = {
  grain: MaterialSeriesGrain;
  points: MaterialSeriesPoint[];
};

export type MaterialFilters = {
  plants: Array<{ id: number; name: string }>;
  items: Array<{ id: number; name: string }>;
};

export type LiftingAuctionRow = {
  auctionId: number;
  auctionNumber: string | null;
  auctionDate: string | null;
  materialApprovedMt: number;
  materialLiftedMt: number;
  materialPendingMt: number;
  breakUp0To5: number;
  breakUp6To10: number;
  breakUpBeyond10: number;
};

export type LiftingDetails = {
  summary: {
    materialApprovedMt: number;
    materialLiftedMt: number;
    materialPendingMt: number;
    breakUp0To5: number;
    breakUp6To10: number;
    breakUpBeyond10: number;
  };
  rows: LiftingAuctionRow[];
};

export type BidderDetails = {
  attachedBidders: MetricWithDelta;
  participatedBidders: MetricWithDelta;
  newBidders: MetricWithDelta;
  currentPeriodLabel: string;
  previousPeriodLabel: string;
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

/** Label for a bucket-start ISO date (`YYYY-MM-DD`) at the given grain. */
function formatMaterialBucketLabel(
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

async function assertUserClientAccess(
  userId: number,
  clientId: number,
): Promise<void> {
  const res = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM user_clients uc
      WHERE uc.user_id = ${userId}
        AND uc.client_id = ${clientId}
        AND uc.is_active = true
    ) AS ok
  `);
  if (res.rows[0]?.ok !== true) {
    throw new ClientDashboardAccessError(
      ClientDashboardMessages.CLIENT_FORBIDDEN,
    );
  }
}

/** Closed, active auctions for client in date range. */
function auctionsInRangeSql(clientId: number, range: IsoDateRange) {
  return sql`
    SELECT a.auction_id
    FROM auctions a
    WHERE a.client_id = ${clientId}
      AND a.status = 'closed'
      AND a.is_active = true
      AND a.auction_date::date >= CAST(${range.from} AS date)
      AND a.auction_date::date <= CAST(${range.to} AS date)
  `;
}

type SummaryScalars = {
  totalAuctions: number;
  totalBidQtyMt: number;
  totalBidValueCr: number;
  attachedBidders: number;
  participatedBidders: number;
  newBidders: number;
  auctionsBidderLt5: number;
  auctionsBidder5To10: number;
  auctionsBidderGt10: number;
  totalApprovedQtyMt: number;
  totalLiftedQtyMt: number;
};

async function loadSummaryScalars(
  clientId: number,
  range: IsoDateRange,
): Promise<SummaryScalars> {
  const res = await db.execute<{
    total_auctions: string | number;
    total_bid_qty_mt: string | number;
    total_bid_value: string | number;
    attached_bidders: string | number;
    participated_bidders: string | number;
    new_bidders: string | number;
    auctions_lt5: string | number;
    auctions_5_10: string | number;
    auctions_gt10: string | number;
    total_approved_qty_mt: string | number;
    total_lifted_qty_mt: string | number;
  }>(sql`
    WITH scoped_auctions AS (
      ${auctionsInRangeSql(clientId, range)}
    ),
    scoped_lots AS (
      SELECT l.*
      FROM auction_lots l
      INNER JOIN scoped_auctions sa ON sa.auction_id = l.auction_id
      WHERE l.is_active = true
    ),
    pmt_lots AS (
      SELECT l.*
      FROM scoped_lots l
      INNER JOIN uoms u ON u.id = l.uom_id
      WHERE ${sql.raw(PMT_UOM_SQL)}
    )
    SELECT
      (SELECT COUNT(*)::int FROM scoped_auctions) AS total_auctions,

      (SELECT COALESCE(SUM(CAST(l.quantity AS decimal(38, 3))), 0)
       FROM pmt_lots l
       WHERE l.bid_count > 0 OR l.bidder_count > 0
      ) AS total_bid_qty_mt,

      (SELECT COALESCE(SUM(
                CAST(l.winning_amount AS decimal(38, 6))
                * CAST(l.quantity AS decimal(38, 6))
              ), 0)
       FROM pmt_lots l
       WHERE l.winning_amount IS NOT NULL
         AND l.winner_bidder_id IS NOT NULL
      ) AS total_bid_value,

      (SELECT COUNT(DISTINCT m.bidder_id)::int
       FROM auction_lot_bidder_maps m
       INNER JOIN scoped_auctions sa ON sa.auction_id = m.auction_id
       WHERE m.is_active = true
         AND m.client_id = ${clientId}
      ) AS attached_bidders,

      (SELECT COUNT(DISTINCT b.bidder_id)::int
       FROM auction_bids b
       INNER JOIN scoped_lots l ON l.id = b.lot_id
      ) AS participated_bidders,

      (SELECT COUNT(*)::int
       FROM (
         SELECT m.bidder_id
         FROM auction_lot_bidder_maps m
         WHERE m.is_active = true
           AND m.client_id = ${clientId}
         GROUP BY m.bidder_id
         HAVING MIN(m.created_at)::date >= CAST(${range.from} AS date)
            AND MIN(m.created_at)::date <= CAST(${range.to} AS date)
            AND EXISTS (
              SELECT 1
              FROM auction_lot_bidder_maps m3
              INNER JOIN scoped_auctions sa ON sa.auction_id = m3.auction_id
              WHERE m3.bidder_id = m.bidder_id
                AND m3.client_id = ${clientId}
                AND m3.is_active = true
            )
       ) nb
      ) AS new_bidders,

      (SELECT COUNT(*)::int FROM (
         SELECT l.auction_id,
                COUNT(DISTINCT b.bidder_id) AS pc
         FROM scoped_lots l
         LEFT JOIN auction_bids b ON b.lot_id = l.id
         GROUP BY l.auction_id
         HAVING COUNT(DISTINCT b.bidder_id) > 0
            AND COUNT(DISTINCT b.bidder_id) < 5
       ) t
      ) AS auctions_lt5,

      (SELECT COUNT(*)::int FROM (
         SELECT l.auction_id,
                COUNT(DISTINCT b.bidder_id) AS pc
         FROM scoped_lots l
         LEFT JOIN auction_bids b ON b.lot_id = l.id
         GROUP BY l.auction_id
         HAVING COUNT(DISTINCT b.bidder_id) BETWEEN 5 AND 10
       ) t
      ) AS auctions_5_10,

      (SELECT COUNT(*)::int FROM (
         SELECT l.auction_id,
                COUNT(DISTINCT b.bidder_id) AS pc
         FROM scoped_lots l
         LEFT JOIN auction_bids b ON b.lot_id = l.id
         GROUP BY l.auction_id
         HAVING COUNT(DISTINCT b.bidder_id) > 10
       ) t
      ) AS auctions_gt10,

      (SELECT COALESCE(SUM(CAST(l.quantity AS decimal(38, 3))), 0)
       FROM pmt_lots l
       WHERE l.is_approved = true
         AND l.winning_amount IS NOT NULL
         AND l.winner_bidder_id IS NOT NULL
      ) AS total_approved_qty_mt,

      (SELECT COALESCE(SUM(CAST(ll.qty AS decimal(38, 3))), 0)
       FROM lifting_client_logs ll
       INNER JOIN pmt_lots l ON l.id = ll.lot_id
       WHERE l.is_approved = true
         AND l.winning_amount IS NOT NULL
         AND l.winner_bidder_id IS NOT NULL
      ) AS total_lifted_qty_mt
  `);

  const row = res.rows[0];
  const bidValue = num(row?.total_bid_value);
  return {
    totalAuctions: Math.round(num(row?.total_auctions)),
    totalBidQtyMt: parseQty(row?.total_bid_qty_mt),
    totalBidValueCr: bidValue,
    attachedBidders: Math.round(num(row?.attached_bidders)),
    participatedBidders: Math.round(num(row?.participated_bidders)),
    newBidders: Math.round(num(row?.new_bidders)),
    auctionsBidderLt5: Math.round(num(row?.auctions_lt5)),
    auctionsBidder5To10: Math.round(num(row?.auctions_5_10)),
    auctionsBidderGt10: Math.round(num(row?.auctions_gt10)),
    totalApprovedQtyMt: parseQty(row?.total_approved_qty_mt),
    totalLiftedQtyMt: parseQty(row?.total_lifted_qty_mt),
  };
}

async function loadDelayReasons(
  clientId: number,
  range: IsoDateRange,
): Promise<DelayReasonRow[]> {
  const res = await db.execute<{
    reason: string;
    lot_count: string | number;
  }>(sql`
    WITH scoped_auctions AS (
      ${auctionsInRangeSql(clientId, range)}
    )
    SELECT
      TRIM(ll.rfdl_reason_description) AS reason,
      COUNT(DISTINCT ll.lot_id)::int AS lot_count
    FROM lifting_client_logs ll
    INNER JOIN scoped_auctions sa ON sa.auction_id = ll.auction_id
    WHERE ll.client_id = ${clientId}
      AND (
        ll.rfdl_id IS NOT NULL
        OR NULLIF(TRIM(ll.rfdl_reason_description), '') IS NOT NULL
      )
      AND NULLIF(TRIM(ll.rfdl_reason_description), '') IS NOT NULL
    GROUP BY TRIM(ll.rfdl_reason_description)
    ORDER BY lot_count DESC, reason ASC
  `);

  return res.rows.map((r) => ({
    reason: r.reason,
    lotCount: Math.round(num(r.lot_count)),
  }));
}

class ClientDashboardService {
  async listClients(userId: number): Promise<DashboardClientOption[]> {
    const res = await db.execute<{
      client_id: number;
      company_name: string;
    }>(sql`
      SELECT c.id AS client_id, c.company_name
      FROM clients c
      INNER JOIN user_clients uc
        ON uc.client_id = c.id AND uc.user_id = ${userId} AND uc.is_active = true
      WHERE c.is_active = true
      ORDER BY c.company_name ASC, c.id ASC
    `);
    return res.rows.map((r) => ({
      clientId: r.client_id,
      companyName: r.company_name,
    }));
  }

  async listAuctions(
    userId: number,
    clientId: number,
    range: IsoDateRange,
  ): Promise<DashboardAuctionOption[]> {
    await assertUserClientAccess(userId, clientId);
    const res = await db.execute<{
      auction_id: number;
      auction_number: string | null;
      auction_date: string | null;
    }>(sql`
      SELECT a.auction_id, a.auction_number,
             to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date
      FROM auctions a
      WHERE a.client_id = ${clientId}
        AND a.status = 'closed'
        AND a.is_active = true
        AND a.auction_date::date >= CAST(${range.from} AS date)
        AND a.auction_date::date <= CAST(${range.to} AS date)
      ORDER BY a.auction_date DESC, a.auction_id DESC
    `);
    return res.rows.map((r) => ({
      auctionId: r.auction_id,
      auctionNumber: r.auction_number,
      auctionDate: r.auction_date,
    }));
  }

  async getSummary(
    userId: number,
    clientId: number,
    range: IsoDateRange,
  ): Promise<DashboardSummary> {
    await assertUserClientAccess(userId, clientId);
    const prior = equalLengthPriorPeriod(range);
    const previousPeriodLabel = formatDashboardPeriodLabel(prior);
    const currentPeriodLabel = formatDashboardPeriodLabel(range);

    const [current, previous, delayReasons] = await Promise.all([
      loadSummaryScalars(clientId, range),
      loadSummaryScalars(clientId, prior),
      loadDelayReasons(clientId, range),
    ]);

    const d = (value: number, previousValue: number) =>
      withDelta(value, previousValue, previousPeriodLabel);

    return {
      totalAuctions: d(current.totalAuctions, previous.totalAuctions),
      totalBidQtyMt: d(current.totalBidQtyMt, previous.totalBidQtyMt),
      totalBidValueCr: d(current.totalBidValueCr, previous.totalBidValueCr),
      attachedBidders: d(current.attachedBidders, previous.attachedBidders),
      participatedBidders: d(
        current.participatedBidders,
        previous.participatedBidders,
      ),
      newBidders: d(current.newBidders, previous.newBidders),
      auctionsBidderLt5: d(
        current.auctionsBidderLt5,
        previous.auctionsBidderLt5,
      ),
      auctionsBidder5To10: d(
        current.auctionsBidder5To10,
        previous.auctionsBidder5To10,
      ),
      auctionsBidderGt10: d(
        current.auctionsBidderGt10,
        previous.auctionsBidderGt10,
      ),
      totalApprovedQtyMt: d(
        current.totalApprovedQtyMt,
        previous.totalApprovedQtyMt,
      ),
      totalLiftedQtyMt: d(current.totalLiftedQtyMt, previous.totalLiftedQtyMt),
      delayReasons,
      currentPeriodLabel,
      previousPeriodLabel,
    };
  }

  async getMaterialFilters(
    userId: number,
    clientId: number,
    range: IsoDateRange,
  ): Promise<MaterialFilters> {
    await assertUserClientAccess(userId, clientId);

    const [plantsRes, itemsRes] = await Promise.all([
      db.execute<{ id: number; name: string }>(sql`
        SELECT DISTINCT pl.id, COALESCE(pl.name, '') AS name
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        INNER JOIN plant_locations pl ON pl.id = l.plant_location_id
        WHERE a.client_id = ${clientId}
          AND a.status = 'closed'
          AND a.is_active = true
          AND l.is_active = true
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
        ORDER BY name ASC, pl.id ASC
      `),
      db.execute<{ id: number; name: string }>(sql`
        SELECT DISTINCT i.id, COALESCE(i.name, '') AS name
        FROM auction_lot_items ali
        INNER JOIN auctions a ON a.auction_id = ali.auction_id
        INNER JOIN items i ON i.id = ali.item_id
        WHERE a.client_id = ${clientId}
          AND a.status = 'closed'
          AND a.is_active = true
          AND ali.is_active = true
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
        ORDER BY name ASC, i.id ASC
      `),
    ]);

    return {
      plants: plantsRes.rows.map((r) => ({ id: r.id, name: r.name })),
      items: itemsRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
      })),
    };
  }

  async getMaterialSeries(
    userId: number,
    clientId: number,
    range: IsoDateRange,
    filters: { plantLocationId?: number; itemId?: number } = {},
  ): Promise<MaterialSeriesResponse> {
    await assertUserClientAccess(userId, clientId);

    const grain = resolveMaterialSeriesGrain(range);
    // Controlled enum only — safe for date_trunc unit.
    const truncUnit = sql.raw(`'${grain}'`);

    const plantFilter =
      filters.plantLocationId != null
        ? sql`AND l.plant_location_id = ${filters.plantLocationId}`
        : sql``;

    const itemFilter =
      filters.itemId != null
        ? sql`AND EXISTS (
            SELECT 1
            FROM auction_lot_items ali
            WHERE ali.lot_id = l.id
              AND ali.is_active = true
              AND ali.item_id = ${filters.itemId}
          )`
        : sql``;

    const res = await db.execute<{
      period: string;
      offered_qty: string | number;
      bid_qty: string | number;
      approved_qty: string | number;
      offered_amount: string | number;
      bid_amount: string | number;
      approved_amount: string | number;
    }>(sql`
      WITH scoped_lots AS (
        SELECT
          l.id,
          l.quantity,
          l.start_bid_price,
          l.winning_amount,
          l.winner_bidder_id,
          l.bid_count,
          l.bidder_count,
          l.is_approved,
          date_trunc(${truncUnit}, a.auction_date)::date AS bucket_start
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        INNER JOIN uoms u ON u.id = l.uom_id
        WHERE a.client_id = ${clientId}
          AND a.status = 'closed'
          AND a.is_active = true
          AND l.is_active = true
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
          AND ${sql.raw(PMT_UOM_SQL)}
          ${plantFilter}
          ${itemFilter}
      )
      SELECT
        to_char(bucket_start, 'YYYY-MM-DD') AS period,
        COALESCE(SUM(CAST(quantity AS decimal(38, 3))), 0) AS offered_qty,
        COALESCE(SUM(
          CASE WHEN bid_count > 0 OR bidder_count > 0
            THEN CAST(quantity AS decimal(38, 3)) ELSE 0 END
        ), 0) AS bid_qty,
        COALESCE(SUM(
          CASE WHEN is_approved = true
                AND winning_amount IS NOT NULL
                AND winner_bidder_id IS NOT NULL
            THEN CAST(quantity AS decimal(38, 3)) ELSE 0 END
        ), 0) AS approved_qty,
        COALESCE(SUM(
          COALESCE(CAST(start_bid_price AS decimal(38, 6)), 0)
          * CAST(quantity AS decimal(38, 6))
        ), 0) AS offered_amount,
        COALESCE(SUM(
          CASE WHEN bid_count > 0 OR bidder_count > 0
            THEN COALESCE(CAST(winning_amount AS decimal(38, 6)), 0)
                 * CAST(quantity AS decimal(38, 6))
            ELSE 0 END
        ), 0) AS bid_amount,
        COALESCE(SUM(
          CASE WHEN is_approved = true
                AND winning_amount IS NOT NULL
                AND winner_bidder_id IS NOT NULL
            THEN CAST(winning_amount AS decimal(38, 6))
                 * CAST(quantity AS decimal(38, 6))
            ELSE 0 END
        ), 0) AS approved_amount
      FROM scoped_lots
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `);

    const points = res.rows.map((r) => ({
      period: r.period,
      periodLabel: formatMaterialBucketLabel(r.period, grain),
      offeredQty: parseQty(r.offered_qty),
      bidQty: parseQty(r.bid_qty),
      approvedQty: parseQty(r.approved_qty),
      offeredAmountLakh: round2(num(r.offered_amount) / 1e5),
      bidAmountLakh: round2(num(r.bid_amount) / 1e5),
      approvedAmountLakh: round2(num(r.approved_amount) / 1e5),
    }));

    return { grain, points };
  }

  async getLiftingDetails(
    userId: number,
    clientId: number,
    range: IsoDateRange,
  ): Promise<LiftingDetails> {
    await assertUserClientAccess(userId, clientId);

    const res = await db.execute<{
      auction_id: number;
      auction_number: string | null;
      auction_date: string | null;
      approved_qty: string | number;
      lifted_qty: string | number;
      break_0_5: string | number;
      break_6_10: string | number;
      break_beyond_10: string | number;
    }>(sql`
      WITH eligible_lots AS (
        SELECT
          l.id AS lot_id,
          l.auction_id,
          a.auction_number,
          to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date,
          a.auction_date::date AS auction_day,
          CAST(l.quantity AS decimal(38, 3)) AS approved_qty
        FROM auction_lots l
        INNER JOIN auctions a ON a.auction_id = l.auction_id
        INNER JOIN uoms u ON u.id = l.uom_id
        WHERE a.client_id = ${clientId}
          AND a.status = 'closed'
          AND a.is_active = true
          AND l.is_active = true
          AND l.is_approved = true
          AND l.winning_amount IS NOT NULL
          AND l.winner_bidder_id IS NOT NULL
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
          AND ${sql.raw(PMT_UOM_SQL)}
      ),
      lift_rows AS (
        SELECT
          el.lot_id,
          el.auction_id,
          CAST(ll.qty AS decimal(38, 3)) AS qty,
          CASE
            WHEN ll.lifting_date IS NULL THEN NULL
            ELSE (ll.lifting_date::date - el.auction_day)
          END AS days_since
        FROM eligible_lots el
        INNER JOIN lifting_client_logs ll
          ON ll.lot_id = el.lot_id AND ll.client_id = ${clientId}
      )
      SELECT
        el.auction_id,
        MAX(el.auction_number) AS auction_number,
        MAX(el.auction_date) AS auction_date,
        COALESCE(SUM(el.approved_qty), 0) AS approved_qty,
        COALESCE((
          SELECT SUM(lr.qty) FROM lift_rows lr WHERE lr.auction_id = el.auction_id
        ), 0) AS lifted_qty,
        COALESCE((
          SELECT SUM(lr.qty) FROM lift_rows lr
          WHERE lr.auction_id = el.auction_id
            AND lr.days_since IS NOT NULL
            AND lr.days_since BETWEEN 0 AND 5
        ), 0) AS break_0_5,
        COALESCE((
          SELECT SUM(lr.qty) FROM lift_rows lr
          WHERE lr.auction_id = el.auction_id
            AND lr.days_since IS NOT NULL
            AND lr.days_since BETWEEN 6 AND 10
        ), 0) AS break_6_10,
        COALESCE((
          SELECT SUM(lr.qty) FROM lift_rows lr
          WHERE lr.auction_id = el.auction_id
            AND lr.days_since IS NOT NULL
            AND lr.days_since > 10
        ), 0) AS break_beyond_10
      FROM eligible_lots el
      GROUP BY el.auction_id
      ORDER BY MAX(el.auction_date) DESC, el.auction_id DESC
    `);

    const rows: LiftingAuctionRow[] = res.rows.map((r) => {
      const approved = parseQty(r.approved_qty);
      const lifted = parseQty(r.lifted_qty);
      return {
        auctionId: r.auction_id,
        auctionNumber: r.auction_number,
        auctionDate: r.auction_date,
        materialApprovedMt: approved,
        materialLiftedMt: lifted,
        materialPendingMt: parseQty(approved - lifted),
        breakUp0To5: parseQty(r.break_0_5),
        breakUp6To10: parseQty(r.break_6_10),
        breakUpBeyond10: parseQty(r.break_beyond_10),
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
        breakUp0To5: parseQty(acc.breakUp0To5 + row.breakUp0To5),
        breakUp6To10: parseQty(acc.breakUp6To10 + row.breakUp6To10),
        breakUpBeyond10: parseQty(acc.breakUpBeyond10 + row.breakUpBeyond10),
      }),
      {
        materialApprovedMt: 0,
        materialLiftedMt: 0,
        materialPendingMt: 0,
        breakUp0To5: 0,
        breakUp6To10: 0,
        breakUpBeyond10: 0,
      },
    );

    return { summary, rows };
  }

  async getBidderDetails(
    userId: number,
    clientId: number,
    range: IsoDateRange,
    auctionId?: number,
  ): Promise<BidderDetails> {
    await assertUserClientAccess(userId, clientId);

    if (auctionId != null) {
      const ok = await db.execute<{ ok: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM auctions a
          WHERE a.auction_id = ${auctionId}
            AND a.client_id = ${clientId}
            AND a.status = 'closed'
            AND a.is_active = true
            AND a.auction_date::date >= CAST(${range.from} AS date)
            AND a.auction_date::date <= CAST(${range.to} AS date)
        ) AS ok
      `);
      if (ok.rows[0]?.ok !== true) {
        throw new ClientDashboardNotFoundError(
          ClientDashboardMessages.AUCTION_NOT_FOUND,
        );
      }
    }

    const prior = equalLengthPriorPeriod(range);
    const previousPeriodLabel = formatDashboardPeriodLabel(prior);
    const currentPeriodLabel = formatDashboardPeriodLabel(range);

    const load = async (r: IsoDateRange) => {
      const auctionFilter =
        auctionId != null
          ? sql`AND m.auction_id = ${auctionId}`
          : sql``;
      const bidAuctionFilter =
        auctionId != null
          ? sql`AND b.auction_id = ${auctionId}`
          : sql``;

      const res = await db.execute<{
        attached: string | number;
        participated: string | number;
        new_bidders: string | number;
      }>(sql`
        WITH scoped_auctions AS (
          ${auctionsInRangeSql(clientId, r)}
        )
        SELECT
          (SELECT COUNT(DISTINCT m.bidder_id)::int
           FROM auction_lot_bidder_maps m
           INNER JOIN scoped_auctions sa ON sa.auction_id = m.auction_id
           WHERE m.is_active = true
             AND m.client_id = ${clientId}
             ${auctionFilter}
          ) AS attached,

          (SELECT COUNT(DISTINCT b.bidder_id)::int
           FROM auction_bids b
           INNER JOIN scoped_auctions sa ON sa.auction_id = b.auction_id
           WHERE 1=1
             ${bidAuctionFilter}
          ) AS participated,

          (SELECT COUNT(*)::int
           FROM (
             SELECT m.bidder_id
             FROM auction_lot_bidder_maps m
             WHERE m.is_active = true
               AND m.client_id = ${clientId}
             GROUP BY m.bidder_id
             HAVING MIN(m.created_at)::date >= CAST(${r.from} AS date)
                AND MIN(m.created_at)::date <= CAST(${r.to} AS date)
                AND EXISTS (
                  SELECT 1
                  FROM auction_lot_bidder_maps m3
                  INNER JOIN scoped_auctions sa ON sa.auction_id = m3.auction_id
                  WHERE m3.bidder_id = m.bidder_id
                    AND m3.client_id = ${clientId}
                    AND m3.is_active = true
                    ${auctionId != null ? sql`AND m3.auction_id = ${auctionId}` : sql``}
                )
           ) nb
          ) AS new_bidders
      `);

      return {
        attached: Math.round(num(res.rows[0]?.attached)),
        participated: Math.round(num(res.rows[0]?.participated)),
        newBidders: Math.round(num(res.rows[0]?.new_bidders)),
      };
    };

    // When auction-scoped, prior period still compares the same auction filter
    // only for the current auction's presence in prior — if auction not in prior,
    // prior counts are 0 (auctionFilter still applies to prior scoped set which
    // won't include this auction). That's correct for % deltas on a single auction.
    const [current, previous] = await Promise.all([
      load(range),
      auctionId != null
        ? Promise.resolve({ attached: 0, participated: 0, newBidders: 0 })
        : load(prior),
    ]);

    return {
      attachedBidders: withDelta(
        current.attached,
        previous.attached,
        previousPeriodLabel,
      ),
      participatedBidders: withDelta(
        current.participated,
        previous.participated,
        previousPeriodLabel,
      ),
      newBidders: withDelta(
        current.newBidders,
        previous.newBidders,
        previousPeriodLabel,
      ),
      currentPeriodLabel,
      previousPeriodLabel,
    };
  }
}

export const clientDashboardService = new ClientDashboardService();

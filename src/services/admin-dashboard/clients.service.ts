import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  formatDashboardPeriodLabel,
  type IsoDateRange,
} from "../../lib/dashboard/period.js";
import { num } from "./helpers.js";

export type ClientsDashboardStats = {
  newClients: number;
  activeClients: number;
  clientsWithAuctions: number;
  dormant: number;
};

export type ClientTopRow = {
  clientId: number;
  clientName: string;
  auctionCount: number;
  lotsOffered: number;
  lotsSold: number;
  saleValue: number;
};

export type ClientsDashboard = {
  stats: ClientsDashboardStats;
  rows: ClientTopRow[];
  currentPeriodLabel: string;
};

type ClientScalars = {
  new_clients: number;
  active_clients: number;
  clients_with_auctions: number;
  dormant: number;
};

async function loadScalars(range: IsoDateRange): Promise<ClientScalars> {
  const res = await db.execute<ClientScalars>(sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM clients c
        WHERE c.created_at::date >= CAST(${range.from} AS date)
          AND c.created_at::date <= CAST(${range.to} AS date)
      ) AS new_clients,
      (
        SELECT COUNT(*)::int
        FROM clients c
        WHERE c.is_active = true
      ) AS active_clients,
      (
        SELECT COUNT(DISTINCT a.client_id)::int
        FROM auctions a
        WHERE a.is_active = true
          AND a.auction_date::date >= CAST(${range.from} AS date)
          AND a.auction_date::date <= CAST(${range.to} AS date)
      ) AS clients_with_auctions,
      (
        SELECT COUNT(*)::int
        FROM clients c
        WHERE c.is_active = true
          AND NOT EXISTS (
            SELECT 1
            FROM auctions a
            WHERE a.client_id = c.id
              AND a.is_active = true
              AND a.auction_date::date >= CAST(${range.from} AS date)
              AND a.auction_date::date <= CAST(${range.to} AS date)
          )
      ) AS dormant
  `);
  const row = res.rows[0];
  return {
    new_clients: num(row?.new_clients),
    active_clients: num(row?.active_clients),
    clients_with_auctions: num(row?.clients_with_auctions),
    dormant: num(row?.dormant),
  };
}

export async function getClients(
  range: IsoDateRange,
): Promise<ClientsDashboard> {
  const currentPeriodLabel = formatDashboardPeriodLabel(range);

  const [current, rowsRes] = await Promise.all([
    loadScalars(range),
    db.execute<{
      client_id: number;
      client_name: string;
      auction_count: number;
      lots_offered: number;
      lots_sold: number;
      sale_value: number;
    }>(sql`
      SELECT
        c.id AS client_id,
        c.company_name AS client_name,
        COUNT(DISTINCT a.auction_id)::int AS auction_count,
        COUNT(l.id) FILTER (WHERE l.is_active = true)::int AS lots_offered,
        COUNT(l.id) FILTER (
          WHERE l.is_active = true AND l.winner_bidder_id IS NOT NULL
        )::int AS lots_sold,
        COALESCE(SUM(
          CAST(l.winning_amount AS decimal(38, 6))
          * CAST(l.quantity AS decimal(38, 6))
        ) FILTER (
          WHERE l.is_active = true AND l.winner_bidder_id IS NOT NULL
        ), 0) AS sale_value
      FROM clients c
      INNER JOIN auctions a
        ON a.client_id = c.id
        AND a.is_active = true
        AND a.auction_date::date >= CAST(${range.from} AS date)
        AND a.auction_date::date <= CAST(${range.to} AS date)
      LEFT JOIN auction_lots l ON l.auction_id = a.auction_id
      GROUP BY c.id, c.company_name
      ORDER BY sale_value DESC
      LIMIT 5
    `),
  ]);

  return {
    stats: {
      newClients: current.new_clients,
      activeClients: current.active_clients,
      clientsWithAuctions: current.clients_with_auctions,
      dormant: current.dormant,
    },
    rows: rowsRes.rows.map((r) => ({
      clientId: num(r.client_id),
      clientName: r.client_name,
      auctionCount: num(r.auction_count),
      lotsOffered: num(r.lots_offered),
      lotsSold: num(r.lots_sold),
      saleValue: num(r.sale_value),
    })),
    currentPeriodLabel,
  };
}

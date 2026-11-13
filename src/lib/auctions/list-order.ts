import { asc, desc, sql } from "drizzle-orm";
import { auctionLots, auctions, clients } from "../../db/schema/index.js";

export type AuctionsListSortBy =
  | "auctionDate"
  | "publishedAt"
  | "auctionNumber"
  | "clientName"
  | "status";

/** Earliest lot start datetime for schedule-bucket SQL filters. */
export function earliestLotStartSql() {
  return sql`COALESCE(
    (
      SELECT date_trunc('day', ${auctions.auctionDate}) + MIN(${auctionLots.startTime})
      FROM ${auctionLots}
      WHERE ${auctionLots.auctionId} = ${auctions.id}
        AND ${auctionLots.isActive} = true
        AND ${auctionLots.startTime} IS NOT NULL
    ),
    ${auctions.auctionDate}
  )`;
}

export function buildAuctionListOrderBy(
  sortBy?: AuctionsListSortBy,
  sortOrder?: "asc" | "desc",
) {
  const dir = sortOrder === "asc" ? asc : desc;
  switch (sortBy) {
    case "auctionNumber":
      return [dir(auctions.auctionNumber)];
    case "clientName":
      return [dir(clients.companyName)];
    case "status":
      return [dir(auctions.status)];
    case "auctionDate":
      return [dir(auctions.auctionDate), dir(auctions.id)];
    case "publishedAt":
    default:
      return [dir(auctions.publishedAt), dir(auctions.id)];
  }
}

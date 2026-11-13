import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";

export type AuctionReportMeta = {
  clientName: string | null;
  auctionNumber: string | null;
  auctionDate: string | null;
};

/** Client name, auction number and auction date (YYYY-MM-DD) for report titles. */
export async function queryAuctionReportMeta(
  clientId: number,
  auctionId: number,
): Promise<AuctionReportMeta> {
  const res = await db.execute<{
    client_name: string | null;
    auction_number: string | null;
    auction_date: string | null;
  }>(sql`
    SELECT c.company_name AS client_name,
           a.auction_number,
           to_char(a.auction_date, 'YYYY-MM-DD') AS auction_date
    FROM auctions a
    JOIN clients c ON c.id = a.client_id
    WHERE a.auction_id = ${auctionId}
      AND a.client_id = ${clientId}
    LIMIT 1
  `);
  const row = res.rows[0];
  return {
    clientName: row?.client_name ?? null,
    auctionNumber: row?.auction_number ?? null,
    auctionDate: row?.auction_date ?? null,
  };
}

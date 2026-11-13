import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export function isPortalClientRole(code: string | undefined): boolean {
  return code === "client" || code === "client_limited";
}

/** True when the user has an active membership on the auction's company. */
export async function userCanAccessAuction(
  userId: number,
  auctionId: number,
): Promise<boolean> {
  const res = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM auctions a
      INNER JOIN user_clients uc
        ON uc.client_id = a.client_id AND uc.is_active = true
      WHERE a.auction_id = ${auctionId}
        AND uc.user_id = ${userId}
        AND a.is_active = true
    ) AS ok
  `);
  return res.rows[0]?.ok === true;
}

/** True when the lot belongs to a company the user is linked to. */
export async function userCanAccessLot(
  userId: number,
  lotId: number,
): Promise<boolean> {
  const res = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM auction_lots l
      INNER JOIN auctions a ON a.auction_id = l.auction_id
      INNER JOIN user_clients uc
        ON uc.client_id = a.client_id AND uc.is_active = true
      WHERE l.id = ${lotId}
        AND uc.user_id = ${userId}
        AND l.is_active = true
        AND a.is_active = true
    ) AS ok
  `);
  return res.rows[0]?.ok === true;
}

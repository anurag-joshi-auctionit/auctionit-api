import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/users.js";

export type ActiveBidderContact = {
  userId: number;
  name: string;
  email: string;
  phone: string | null;
  whatsapp: string | null;
};

/**
 * Linked login user for a bidder that may receive notifications.
 * Requires `users.is_active` and a non-empty email.
 */
export async function getActiveBidderContact(
  bidderId: number,
): Promise<ActiveBidderContact | null> {
  const [row] = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.emailId,
      phone: users.phoneNumber,
      whatsapp: users.whatsappNumber,
    })
    .from(users)
    .where(and(eq(users.bidderId, bidderId), eq(users.isActive, true)))
    .limit(1);

  const email = row?.email?.trim() ?? "";
  if (!row || !email) return null;

  return {
    userId: row.userId,
    name: row.name,
    email,
    phone: row.phone?.trim() || null,
    whatsapp: row.whatsapp?.trim() || null,
  };
}

/** Drizzle join fragment helpers for bulk notification queries. */
export const activeBidderUserJoin = {
  bidderId: users.bidderId,
  isActive: users.isActive,
  emailId: users.emailId,
  phoneNumber: users.phoneNumber,
  name: users.name,
  whatsappNumber: users.whatsappNumber,
  userId: users.id,
};

import type pg from "pg";

export const POC_NAME = "Anurag Joshi";
export const POC_EMAIL = "anurag.joshi@auctionit.in";
export const POC_MOBILE = "9311334992";
export const BILLING_NAME = "Anurag Joshi";
export const BILLING_EMAIL_TO = "kashish.kesharwani@auctionit.in";
export const BILLING_EMAIL_CC =
  "anurag.joshi@auctionit.in, kumar.abhinav@auctionit.in";

export type SanitizeCounts = {
  bidderUsers: number;
  clientUsers: number;
  plants: number;
  clients: number;
  outbox: number;
};

/**
 * Bulk-overwrites contact PII for all bidder/client users, plant locations,
 * clients, and queued email outbox rows with internal test recipients.
 * Idempotent — safe to call after every seed that touches these tables.
 * Refuses to run on NODE_ENV=production.
 */
export async function applySanitizeContacts(
  client: pg.PoolClient,
): Promise<SanitizeCounts> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "applySanitizeContacts: refusing to run in NODE_ENV=production",
    );
  }

  const r1 = await client.query(
    `UPDATE users SET
       email_id = $1,
       phone_number = $2,
       secondary_phone_number = $2,
       whatsapp_number = $2,
       whatsapp_sec_number = $2
     WHERE bidder_id IS NOT NULL`,
    [POC_EMAIL, POC_MOBILE],
  );

  const r2 = await client.query(
    `UPDATE users u SET
       name = $1,
       email_id = $2,
       phone_number = $3,
       secondary_phone_number = $3,
       whatsapp_number = $3,
       whatsapp_sec_number = $3
     FROM user_clients uc
     WHERE uc.user_id = u.id`,
    [POC_NAME, POC_EMAIL, POC_MOBILE],
  );

  const r3 = await client.query(
    `UPDATE plant_locations SET
       poc_name = $1,
       poc_email = $2,
       poc_phone = $3,
       billing_name = $4,
       billing_email_to = $5,
       billing_email_cc = $6`,
    [POC_NAME, POC_EMAIL, POC_MOBILE, BILLING_NAME, BILLING_EMAIL_TO, BILLING_EMAIL_CC],
  );

  const r4 = await client.query(
    `UPDATE clients SET email = $1, phone = $2`,
    [POC_EMAIL, POC_MOBILE],
  );

  const r5 = await client.query(
    `UPDATE notification_email_logs
     SET email_to = CASE
           WHEN source_type = 'service_invoice' THEN $1
           ELSE $2
         END,
         email_cc = $3
     WHERE status IN ('queued', 'sending')`,
    [BILLING_EMAIL_TO, POC_EMAIL, BILLING_EMAIL_CC],
  );

  return {
    bidderUsers: r1.rowCount ?? 0,
    clientUsers: r2.rowCount ?? 0,
    plants: r3.rowCount ?? 0,
    clients: r4.rowCount ?? 0,
    outbox: r5.rowCount ?? 0,
  };
}

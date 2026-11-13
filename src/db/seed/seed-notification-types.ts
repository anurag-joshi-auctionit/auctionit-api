import pg from "pg";
import { env } from "../../env.js";
import {
  NOTIFICATION_TYPE_SERVICE_INVOICE_ANNEXURE,
  NOTIFICATION_TYPE_SUBSCRIPTION_ANNEXURE,
  NOTIFICATION_TYPE_ADHOC_SEND,
  NOTIFICATION_TYPE_LOT_CONFIRMATION,
  NOTIFICATION_TYPE_CATALOGUE_NOTIFICATION,
  NOTIFICATION_TYPE_SUBSCRIPTION_PAYMENT_LINK,
  NOTIFICATION_TYPE_EMD_FORFEITED,
  NOTIFICATION_TYPE_AUCTION_ABOUT_TO_START,
  NOTIFICATION_TYPE_AUCTION_CONCLUDED,
  NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_BEFORE_DUE,
  NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_AFTER_DUE,
} from "../schema/notification-types.js";

const MODULE_TYPES: Array<{ id: number; description: string }> = [
  {
    id: NOTIFICATION_TYPE_AUCTION_ABOUT_TO_START,
    description: "Auction about to start",
  },
  {
    id: NOTIFICATION_TYPE_AUCTION_CONCLUDED,
    description: "Auction has been concluded",
  },
  {
    id: NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_BEFORE_DUE,
    description: "Service Invoice — Payment Reminder (Before Due)",
  },
  {
    id: NOTIFICATION_TYPE_SI_PAYMENT_REMINDER_AFTER_DUE,
    description: "Service Invoice — Payment Reminder (After Due)",
  },
  {
    id: NOTIFICATION_TYPE_SERVICE_INVOICE_ANNEXURE,
    description: "Service Invoice — Annexure Email",
  },
  {
    id: NOTIFICATION_TYPE_SUBSCRIPTION_ANNEXURE,
    description: "Subscription — Invoice Email",
  },
  {
    id: NOTIFICATION_TYPE_ADHOC_SEND,
    description: "Ad-hoc Send Email",
  },
  {
    id: NOTIFICATION_TYPE_LOT_CONFIRMATION,
    description: "Lot Confirmation Letter",
  },
  {
    id: NOTIFICATION_TYPE_CATALOGUE_NOTIFICATION,
    description: "Auction Catalogue Notification",
  },
  {
    id: NOTIFICATION_TYPE_SUBSCRIPTION_PAYMENT_LINK,
    description: "Subscription — Payment Link Email",
  },
  {
    id: NOTIFICATION_TYPE_EMD_FORFEITED,
    description: "EMD — Forfeiture Notice",
  },
];

const UPSERT_SQL = `
INSERT INTO notification_types (
  id, description, is_active, created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, true, now(), NULL, NULL, NULL
)
ON CONFLICT (id) DO UPDATE SET
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active
`;

async function main() {
  const started = Date.now();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of MODULE_TYPES) {
      await client.query(UPSERT_SQL, [t.id, t.description]);
      console.log(`Upserted notification type id=${t.id} "${t.description}"`);
    }
    await client.query("COMMIT");
    console.log(`Done in ${Date.now() - started}ms.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

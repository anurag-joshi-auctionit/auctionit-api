import pg from "pg";
import { env } from "../../env.js";
import { connectMssql } from "./mssql.js";

const SOURCE_SQL = `
SELECT
  UserId        AS userId,
  BidderCompId  AS bidderId
FROM tbl_Config_BidderCompUser
`;

const UPDATE_SQL = `
UPDATE users SET bidder_id = $2 WHERE id = $1
`;

type SourceRow = {
  userId: number;
  bidderId: number;
};

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} bidder-user rows from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [userRows, bidderRows] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM users"),
      pgPool.query<{ id: number }>("SELECT id FROM bidders"),
    ]);
    const validUserIds = new Set(userRows.rows.map((r) => r.id));
    const validBidderIds = new Set(bidderRows.rows.map((r) => r.id));

    const client = await pgPool.connect();
    let updated = 0;
    let skippedMissingUser = 0;
    let skippedMissingBidder = 0;
    let skippedDuplicate = 0;

    // The schema enforces a strict 1:1 mapping (bidder_id unique on users).
    // The legacy composite-key table can in theory hold duplicates, so keep
    // only the first occurrence of each user_id / bidder_id.
    const seenUserIds = new Set<number>();
    const seenBidderIds = new Set<number>();

    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        if (!validUserIds.has(r.userId)) {
          skippedMissingUser++;
          continue;
        }
        if (!validBidderIds.has(r.bidderId)) {
          skippedMissingBidder++;
          continue;
        }
        if (seenUserIds.has(r.userId) || seenBidderIds.has(r.bidderId)) {
          skippedDuplicate++;
          continue;
        }
        seenUserIds.add(r.userId);
        seenBidderIds.add(r.bidderId);

        await client.query(UPDATE_SQL, [r.userId, r.bidderId]);
        updated++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Updated bidder_id on ${updated} users ` +
        `(${skippedMissingUser} skipped: user not in Postgres, ` +
        `${skippedMissingBidder} skipped: bidder not in Postgres, ` +
        `${skippedDuplicate} skipped: duplicate user/bidder) ` +
        `in ${Date.now() - started}ms.`,
    );
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import pg from "pg";
import { env } from "../../env.js";
import { updateBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";

const SOURCE_SQL = `
SELECT
  UserId        AS userId,
  BidderCompId  AS bidderId
FROM tbl_Config_BidderCompUser
`;

const UPDATE_SQL = `
UPDATE users
SET bidder_id = r.bidder_id::int
FROM json_to_recordset($1::json) AS r(user_id int, bidder_id int)
WHERE users.id = r.user_id
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

    // De-duplicate in memory (1:1 mapping enforced by schema)
    let skippedMissingUser = 0;
    let skippedMissingBidder = 0;
    let skippedDuplicate = 0;
    const seenUserIds = new Set<number>();
    const seenBidderIds = new Set<number>();
    const updateRows: { user_id: number; bidder_id: number }[] = [];

    for (const r of result.recordset) {
      if (!validUserIds.has(r.userId)) { skippedMissingUser++; continue; }
      if (!validBidderIds.has(r.bidderId)) { skippedMissingBidder++; continue; }
      if (seenUserIds.has(r.userId) || seenBidderIds.has(r.bidderId)) { skippedDuplicate++; continue; }
      seenUserIds.add(r.userId);
      seenBidderIds.add(r.bidderId);
      updateRows.push({ user_id: r.userId, bidder_id: r.bidderId });
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await updateBatched(client, "users.bidder_id", UPDATE_SQL, updateRows);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Updated bidder_id on ${updateRows.length} users ` +
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

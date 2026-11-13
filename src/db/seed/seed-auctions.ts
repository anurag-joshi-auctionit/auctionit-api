import pg from "pg";
import { env } from "../../env.js";
import {
  AUCTION_TYPES,
  type AuctionType,
} from "../schema/auctions.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { resolveAuctionSeedStatus } from "./seed-auctions-status.js";
import { legacySealedBidWindow } from "./seed-sealed-bid-window.js";
import { connectMssql } from "./mssql.js";

const SOURCE_SQL = `
SELECT
  a.AuctionId                                  AS auctionId,
  a.ClientId                                   AS clientId,
  LTRIM(RTRIM(a.AuctionNumber))                AS auctionNumber,
  LTRIM(RTRIM(a.AuctionType))                  AS auctionType,
  a.EMDAmount                                  AS consolidatedEmdAmount,
  CONVERT(varchar(33), a.AuctionDate, 126)             AS auctionDate,
  CONVERT(varchar(33), a.AuctionPublishStartDate, 126) AS auctionPublishStartDate,
  a.IsClosed                                   AS isClosed,
  a.IsDeleted                                  AS isDeleted,
  a.IsPublished                                AS isPublished,
  a.IsActive                                   AS isActive,
  CONVERT(varchar(33), a.CreateDatetime, 126)          AS createdAt,
  a.CreatedBy                                  AS createdBy,
  CONVERT(varchar(33), a.UpdateDatetime, 126)          AS updatedAt,
  a.UpdatedBy                                  AS updatedBy,
  a.AutoIncrementTimeInMinute                  AS noBidExtensionInterval,
  a.NumberOfTimeAutoIncrement                  AS noBidExtensionCountMax,
  a.IsAuctionAutoIncrement                     AS isNoBidExtension,
  a.SBPPlusIncrementEnabled                    AS isStartBidPricePlusIncrement,
  a.OnlineSealedBidEnabled                     AS isSealedBid,
  CONVERT(varchar(33), a.OnlineSealedBidPublishStartDate, 126) AS sealedBidPublishStartDate,
  a.WindowOpeningDurationInHours               AS sealedBidDurationHours,
  a.IPAddressRestrictionEnabled                AS ipAddressRestrictionEnabled,
  a.ShowRanking                                AS isRankBased,
  (
    SELECT COUNT(*)
    FROM tbl_Data_AuctionLot al
    WHERE al.AuctionId = a.AuctionId AND al.IsActive = 1
  ) AS activeLotCount
FROM tbl_Data_Auction a
`;

const UPSERT_SQL = `
INSERT INTO auctions (
  auction_id, client_id,
  auction_number, auction_type, consolidated_emd_amount,
  auction_date,
  status, published_at, closed_at,
  is_active,
  no_bid_extension_interval, no_bid_extension_count_max,
  is_no_bid_extension, is_start_bid_price_plus_increment,
  is_sealed_bid, sealed_bid_date, sealed_bid_start_time, sealed_bid_end_time,
  ip_address_restriction_enabled, is_rank_based,
  created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2,
  $3, $4, $5,
  $6,
  $7, $8, $9,
  $10,
  $11, $12,
  $13, $14,
  $15, $16, $17, $18,
  $19, $20,
  $21, $22, $23, $24
)
ON CONFLICT (auction_id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  auction_number = EXCLUDED.auction_number,
  auction_type = EXCLUDED.auction_type,
  consolidated_emd_amount = EXCLUDED.consolidated_emd_amount,
  auction_date = EXCLUDED.auction_date,
  status = EXCLUDED.status,
  published_at = EXCLUDED.published_at,
  closed_at = EXCLUDED.closed_at,
  is_active = EXCLUDED.is_active,
  no_bid_extension_interval = EXCLUDED.no_bid_extension_interval,
  no_bid_extension_count_max = EXCLUDED.no_bid_extension_count_max,
  is_no_bid_extension = EXCLUDED.is_no_bid_extension,
  is_start_bid_price_plus_increment = EXCLUDED.is_start_bid_price_plus_increment,
  is_sealed_bid = EXCLUDED.is_sealed_bid,
  sealed_bid_date = EXCLUDED.sealed_bid_date,
  sealed_bid_start_time = EXCLUDED.sealed_bid_start_time,
  sealed_bid_end_time = EXCLUDED.sealed_bid_end_time,
  ip_address_restriction_enabled = EXCLUDED.ip_address_restriction_enabled,
  is_rank_based = EXCLUDED.is_rank_based,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
  auctionId: number;
  clientId: number;
  auctionNumber: string | null;
  auctionType: string | null;
  consolidatedEmdAmount: string | number | null;
  auctionDate: string;
  auctionPublishStartDate: string;
  isClosed: boolean;
  isDeleted: boolean;
  isPublished: boolean;
  isActive: boolean;
  createdAt: string;
  createdBy: number;
  updatedAt: string | null;
  updatedBy: number | null;
  noBidExtensionInterval: number | null;
  noBidExtensionCountMax: number | null;
  isNoBidExtension: boolean | null;
  isStartBidPricePlusIncrement: boolean | null;
  isSealedBid: boolean | null;
  sealedBidPublishStartDate: string | null;
  sealedBidDurationHours: string | number | null;
  ipAddressRestrictionEnabled: boolean | null;
  isRankBased: boolean;
  activeLotCount: number;
};

function asString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function asBool(v: boolean | number | null | undefined): boolean | null {
  if (v == null) return null;
  return Boolean(v);
}

function nonNegativeNumeric(
  v: string | number | null | undefined,
): string | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(n);
}

function normalizeAuctionType(v: string | null): AuctionType | null {
  const s = asString(v);
  if (!s) return null;
  const lower = s.toLowerCase();
  return (AUCTION_TYPES as readonly string[]).includes(lower)
    ? (lower as AuctionType)
    : null;
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(`Pulled ${result.recordset.length} auction rows from MSSQL.`);
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [userIdsResult, clientIdsResult] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM users"),
      pgPool.query<{ id: number }>("SELECT id FROM clients"),
    ]);
    const validUserIds = new Set(userIdsResult.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);
    const validClientIds = new Set(clientIdsResult.rows.map((r) => r.id));

    const client = await pgPool.connect();
    let upserted = 0;
    let skippedNoClient = 0;
    const cappedSealedWindows: number[] = [];
    let defaultedCreatedBy = 0;
    let defaultedUpdatedBy = 0;
    let nulledAuctionType = 0;
    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        if (!validClientIds.has(r.clientId)) {
          skippedNoClient++;
          continue;
        }

        const createdBy = resolveAuditUserId(r.createdBy, validUserIds);
        if (r.createdBy !== createdBy) defaultedCreatedBy++;
        const updatedBy = resolveAuditUserIdIfTimestamp(
          r.updatedAt,
          r.updatedBy,
          validUserIds,
        );
        if (
          r.updatedAt != null &&
          (r.updatedBy == null || r.updatedBy !== updatedBy)
        ) {
          defaultedUpdatedBy++;
        }

        const auctionType = normalizeAuctionType(r.auctionType);
        if (r.auctionType != null && auctionType === null) nulledAuctionType++;

        const resolved = resolveAuctionSeedStatus({
          isDeleted: Boolean(r.isDeleted),
          isClosed: Boolean(r.isClosed),
          isPublished: Boolean(r.isPublished),
          activeLotCount: Number(r.activeLotCount) || 0,
          updatedAt: r.updatedAt,
        });

        const sealedWindow = legacySealedBidWindow(
          r.sealedBidPublishStartDate,
          r.sealedBidDurationHours,
        );
        if (sealedWindow.capped) cappedSealedWindows.push(r.auctionId);

        await client.query(UPSERT_SQL, [
          r.auctionId,
          r.clientId,
          asString(r.auctionNumber),
          auctionType,
          nonNegativeNumeric(r.consolidatedEmdAmount),
          r.auctionDate,
          resolved.status,
          r.auctionPublishStartDate,
          resolved.closedAt,
          Boolean(r.isActive),
          r.noBidExtensionInterval != null &&
          Number(r.noBidExtensionInterval) > 0
            ? Number(r.noBidExtensionInterval) * 60
            : r.noBidExtensionInterval,
          r.noBidExtensionCountMax,
          asBool(r.isNoBidExtension),
          asBool(r.isStartBidPricePlusIncrement),
          asBool(r.isSealedBid) ?? false,
          sealedWindow.sealedBidDate,
          sealedWindow.sealedBidStartTime,
          sealedWindow.sealedBidEndTime,
          asBool(r.ipAddressRestrictionEnabled),
          Boolean(r.isRankBased),
          r.createdAt,
          createdBy,
          r.updatedAt,
          updatedBy,
        ]);
        upserted++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    console.log(
      `Upserted ${upserted} rows into auctions ` +
        `(${skippedNoClient} skipped: client not in Postgres, ` +
        `defaulted created_by to 1 on ${defaultedCreatedBy} rows, ` +
        `nulled auction_type on ${nulledAuctionType} rows, ` +
        `defaulted updated_by to 1 on ${defaultedUpdatedBy} rows) ` +
        `in ${Date.now() - started}ms.`,
    );
    if (cappedSealedWindows.length > 0) {
      console.warn(
        `Capped sealed-bid window end at 23:59:59 (crossed midnight) on ` +
          `${cappedSealedWindows.length} auctions: ${cappedSealedWindows.join(", ")}`,
      );
    }
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

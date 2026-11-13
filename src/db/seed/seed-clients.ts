import pg from "pg";
import { env } from "../../env.js";
import {
    resolveAuditUserId,
    resolveAuditUserIdIfTimestamp,
    SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import {
    asString,
    loadLocationLookupMap,
    locationIdSubquery,
    normalizeCity,
    normalizeCountry,
    normalizeGstin,
    normalizePan,
    normalizePincode,
    resolveSeedServiceFee,
    normalizeState,
    normalizeTan,
    resolveLocationId,
} from "./resolve-location-id.js";

const SOURCE_SQL = `
SELECT
  ClientId                       AS clientId,
  CompanyName                    AS companyName,
  RegisteredAddress              AS address,
  LTRIM(RTRIM(Country))          AS country,
  LTRIM(RTRIM(State))            AS state,
  LTRIM(RTRIM(City))             AS city,
  LTRIM(RTRIM(PinCode))          AS pincode,
  PhoneNumber                    AS phone,
  WebSiteURL                     AS website,
  PAN                            AS pan,
  TAN                            AS tan,
  TIN                            AS gstin,
  IsActive                       AS isActive,
  PrefixAuctionCode              AS auctionPrefix,
  AutoExtend                     AS isLastBidExtension,
  ExtendInSec                    AS lastBidExtensionWindow,
  ExtendDuration                 AS lastBidExtensionInterval,
  Extension_NoOfTimes            AS lastBidExtensionCountMax,
  StaggeringOfLots               AS staggeringLotsMode,
  StaggeringOfLotsDuration       AS staggerInterval,
  RevenueRate                    AS serviceFee,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy                      AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy                      AS updatedBy
FROM tbl_Config_ClientMst
`;

const UPSERT_SQL = `
INSERT INTO clients (
  id, company_name, address, location_id, pincode,
  phone, website, email, pan, tan, gstin, is_active,
  auction_prefix, service_fee_type, service_fee_value,
  is_last_bid_extension, last_bid_extension_window, last_bid_extension_interval, last_bid_extension_count_max,
  is_staggered, stagger_interval,
  created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3,
  ${locationIdSubquery("$4", "$5", "$6")},
  $7, $8, $9, $10, $11, $12, $13, $14,
  $15, $16, $17,
  $18, $19, $20, $21,
  $22, $23,
  $24, $25, $26, $27
)
ON CONFLICT (id) DO UPDATE SET
  company_name = EXCLUDED.company_name,
  address = EXCLUDED.address,
  location_id = EXCLUDED.location_id,
  pincode = EXCLUDED.pincode,
  phone = EXCLUDED.phone,
  website = EXCLUDED.website,
  email = EXCLUDED.email,
  pan = EXCLUDED.pan,
  tan = EXCLUDED.tan,
  gstin = EXCLUDED.gstin,
  is_active = EXCLUDED.is_active,
  auction_prefix = EXCLUDED.auction_prefix,
  service_fee_type = EXCLUDED.service_fee_type,
  service_fee_value = EXCLUDED.service_fee_value,
  is_last_bid_extension = EXCLUDED.is_last_bid_extension,
  last_bid_extension_window = EXCLUDED.last_bid_extension_window,
  last_bid_extension_interval = EXCLUDED.last_bid_extension_interval,
  last_bid_extension_count_max = EXCLUDED.last_bid_extension_count_max,
  is_staggered = EXCLUDED.is_staggered,
  stagger_interval = EXCLUDED.stagger_interval,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
    clientId: number;
    companyName: string;
    address: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    pincode: string | null;
    phone: string | null;
    website: string | null;
    pan: string | null;
    tan: string | null;
    gstin: string | null;
    isActive: boolean;
    auctionPrefix: string | null;
    isLastBidExtension: boolean;
    lastBidExtensionWindow: number | null;
    lastBidExtensionInterval: number | null;
    lastBidExtensionCountMax: number | null;
    /** Legacy enum: 0 = None, 1 = All Lots, 2 = Subsequent Lots. */
    staggeringLotsMode: number;
    staggerInterval: number;
    serviceFee: number | null;
    createdAt: string;
    createdBy: number;
    updatedAt: string | null;
    updatedBy: number | null;
};

async function main() {
    const started = Date.now();
    const mssqlPool = await connectMssql();
    const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

    try {
        const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
        console.log(`Pulled ${result.recordset.length} client rows from MSSQL.`);
        if (result.recordset.length === 0) {
            console.log("Nothing to seed.");
            return;
        }

        const locationMap = await loadLocationLookupMap(pgPool);
        const userIdsResult = await pgPool.query<{ id: number }>(
            "SELECT id FROM users",
        );
        const validUserIds = new Set(userIdsResult.rows.map((r) => r.id));
        validUserIds.add(SEED_DEFAULT_USER_ID);

        const client = await pgPool.connect();
        let upserted = 0;
        let skippedLocation = 0;
        let skippedServiceFee = 0;
        let defaultedCreatedBy = 0;
        const unmatchedLocations: Array<{
            clientId: number;
            country: string;
            state: string | null;
            city: string | null;
        }> = [];

        try {
            await client.query("BEGIN");
            for (const r of result.recordset) {
                const serviceFee = resolveSeedServiceFee(r.serviceFee);
                if (serviceFee == null) {
                    skippedServiceFee++;
                    continue;
                }

                const country = normalizeCountry(r.country);
                const state = normalizeState(r.state);
                const city = normalizeCity(r.city);
                const resolved = resolveLocationId(
                    locationMap,
                    r.country,
                    r.state,
                    r.city,
                );

                if (!state || !city) {
                    skippedLocation++;
                } else if (resolved.locationId == null) {
                    skippedLocation++;
                    unmatchedLocations.push({
                        clientId: r.clientId,
                        country,
                        state,
                        city,
                    });
                }

                const createdBy = resolveAuditUserId(
                    r.createdBy,
                    validUserIds,
                );
                if (r.createdBy !== createdBy) defaultedCreatedBy++;
                const updatedBy = resolveAuditUserIdIfTimestamp(
                    r.updatedAt,
                    r.updatedBy,
                    validUserIds,
                );

                const lastBidWindow = Number(r.lastBidExtensionWindow) || 0;
                const lastBidInterval = Number(r.lastBidExtensionInterval) || 0;
                const lastBidMax = Number(r.lastBidExtensionCountMax) || 0;
                const staggerInterval = Number(r.staggerInterval) || 0;
                // Legacy StaggeringOfLots is an enum (0 None / 1 All Lots /
                // 2 Subsequent Lots), not a boolean. The engine implements
                // subsequent-lot chaining only, so any non-zero mode imports
                // as staggered. The CHECK needs interval > 0 when on.
                const isStaggered =
                    Number(r.staggeringLotsMode) !== 0 && staggerInterval > 0;

                await client.query(UPSERT_SQL, [
                    r.clientId,
                    r.companyName,
                    asString(r.address),
                    country,
                    state,
                    city,
                    normalizePincode(r.pincode),
                    asString(r.phone),
                    asString(r.website),
                    null,
                    normalizePan(r.pan),
                    normalizeTan(r.tan),
                    normalizeGstin(r.gstin),
                    Boolean(r.isActive),
                    asString(r.auctionPrefix),
                    serviceFee.type,
                    serviceFee.value,
                    // Last-bid flag stays derived from its triple.
                    lastBidWindow > 0 && lastBidInterval > 0 && lastBidMax > 0,
                    lastBidWindow,
                    lastBidInterval,
                    lastBidMax,
                    isStaggered,
                    staggerInterval,
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
            `Upserted ${upserted} rows into clients ` +
                `(${skippedLocation} without resolved location_id, ` +
                `${skippedServiceFee} skipped missing/invalid RevenueRate, ` +
                `defaulted created_by to 1 on ${defaultedCreatedBy} rows) ` +
                `in ${Date.now() - started}ms.`,
        );

        if (unmatchedLocations.length > 0) {
            console.log("Unmatched location triples (sample up to 20):");
            console.table(unmatchedLocations.slice(0, 20));
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

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
    normalizeGstin,
    normalizePan,
    normalizePincode,
    resolveLocationId,
} from "./resolve-location-id.js";

const CLIENT_KAM_SQL = `
SELECT ClientId AS clientId, KamUserId AS kamUserId
FROM tbl_Config_ClientMst
WHERE KamUserId IS NOT NULL
`;

const SOURCE_SQL = `
SELECT
  LocationId                     AS locationId,
  ClientId                       AS clientId,
  LocationName                   AS locationName,
  RegisteredAddress              AS address,
  LTRIM(RTRIM(Country))          AS country,
  LTRIM(RTRIM(State))            AS state,
  LTRIM(RTRIM(City))             AS city,
  LTRIM(RTRIM(PinCode))          AS pincode,
  PersonResponsibleName          AS pocName,
  PersonResponsibleEmail         AS pocEmail,
  PersonResponsiblePhone         AS pocPhone,
  BillingName                    AS billingName,
  BillingEmailId                 AS billingEmailTo,
  BillingEmailIdCc               AS billingEmailCc,
  GracePeriod                    AS gracePeriod,
  GSTIN                          AS gstin,
  PAN                            AS pan,
  OrderNumber                    AS orderNumber,
  CONVERT(varchar(33), OrderNumberDate, 126) AS orderDate,
  IsActive                       AS isActive,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy                      AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy                      AS updatedBy
FROM tbl_Config_PlantLocation
`;

const UPSERT_SQL = `
INSERT INTO plant_locations (
  id, client_id, name, address, country, state, city, location_id, pincode, is_active,
  poc_name, poc_email, poc_phone,
  billing_name, billing_email_to, billing_email_cc,
  grace_period, gstin, pan, order_number, order_date, kam_id,
  created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  $11, $12, $13,
  $14, $15, $16,
  $17, $18, $19, $20, $21, $22,
  $23, $24, $25, $26
)
ON CONFLICT (id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  name = EXCLUDED.name,
  address = EXCLUDED.address,
  country = EXCLUDED.country,
  state = EXCLUDED.state,
  city = EXCLUDED.city,
  location_id = EXCLUDED.location_id,
  pincode = EXCLUDED.pincode,
  is_active = EXCLUDED.is_active,
  poc_name = EXCLUDED.poc_name,
  poc_email = EXCLUDED.poc_email,
  poc_phone = EXCLUDED.poc_phone,
  billing_name = EXCLUDED.billing_name,
  billing_email_to = EXCLUDED.billing_email_to,
  billing_email_cc = EXCLUDED.billing_email_cc,
  grace_period = EXCLUDED.grace_period,
  gstin = EXCLUDED.gstin,
  pan = EXCLUDED.pan,
  order_number = EXCLUDED.order_number,
  order_date = EXCLUDED.order_date,
  kam_id = EXCLUDED.kam_id,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
    locationId: number;
    clientId: number | null;
    locationName: string | null;
    address: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    pincode: string | null;
    pocName: string | null;
    pocEmail: string | null;
    pocPhone: string | null;
    billingName: string | null;
    billingEmailTo: string | null;
    billingEmailCc: string | null;
    gracePeriod: number | null;
    gstin: string | null;
    pan: string | null;
    orderNumber: string | null;
    orderDate: string | null;
    isActive: boolean;
    createdAt: string;
    createdBy: number;
    updatedAt: string | null;
    updatedBy: number | null;
};

async function loadClientIds(pool: pg.Pool): Promise<Set<number>> {
    const res = await pool.query<{ id: number }>(
        "SELECT id FROM clients",
    );
    return new Set(res.rows.map((r) => Number(r.id)));
}

async function loadUserIds(pool: pg.Pool): Promise<Set<number>> {
    const res = await pool.query<{ id: number }>("SELECT id FROM users");
    return new Set(res.rows.map((r) => Number(r.id)));
}

async function loadClientKamMap(
    mssqlPool: Awaited<ReturnType<typeof connectMssql>>,
): Promise<Map<number, number>> {
    const res = await mssqlPool
        .request()
        .query<{ clientId: number; kamUserId: number }>(CLIENT_KAM_SQL);
    const map = new Map<number, number>();
    for (const row of res.recordset) {
        if (row.clientId != null && row.kamUserId != null) {
            map.set(Number(row.clientId), Number(row.kamUserId));
        }
    }
    return map;
}

async function main() {
    const started = Date.now();
    const mssqlPool = await connectMssql();
    const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

    try {
        const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
        console.log(
            `Pulled ${result.recordset.length} plant location rows from MSSQL.`,
        );
        if (result.recordset.length === 0) {
            console.log("Nothing to seed.");
            return;
        }

        const [locationMap, clientIds, userIds, clientKamMap] = await Promise.all([
            loadLocationLookupMap(pgPool),
            loadClientIds(pgPool),
            loadUserIds(pgPool),
            loadClientKamMap(mssqlPool),
        ]);
        userIds.add(SEED_DEFAULT_USER_ID);

        let kamAssigned = 0;
        let kamSkipped = 0;

        const client = await pgPool.connect();
        let upserted = 0;
        let skippedClient = 0;
        let defaultedCreatedBy = 0;
        let unresolvedLocation = 0;
        const unmatchedLocations: Array<{
            id: number;
            clientId: number | null;
            country: string;
            state: string | null;
            city: string | null;
        }> = [];

        try {
            await client.query("BEGIN");
            for (const r of result.recordset) {
                const clientId =
                    r.clientId == null ? null : Number(r.clientId);
                if (clientId == null || !clientIds.has(clientId)) {
                    skippedClient++;
                    continue;
                }

                const createdByRaw =
                    r.createdBy == null ? null : Number(r.createdBy);
                const createdBy = resolveAuditUserId(createdByRaw, userIds);
                if (createdByRaw !== createdBy) defaultedCreatedBy++;

                const resolved = resolveLocationId(
                    locationMap,
                    r.country,
                    r.state,
                    r.city,
                );
                if (resolved.locationId == null && resolved.state && resolved.city) {
                    unresolvedLocation++;
                    unmatchedLocations.push({
                        id: r.locationId,
                        clientId,
                        country: resolved.country,
                        state: resolved.state,
                        city: resolved.city,
                    });
                } else if (resolved.locationId == null) {
                    unresolvedLocation++;
                }

                const kamCandidate = clientKamMap.get(clientId);
                const kamId =
                    kamCandidate != null && userIds.has(Number(kamCandidate))
                        ? Number(kamCandidate)
                        : null;
                if (kamId != null) {
                    kamAssigned++;
                } else if (kamCandidate != null) {
                    kamSkipped++;
                }

                const updatedByRaw =
                    r.updatedBy == null ? null : Number(r.updatedBy);

                await client.query(UPSERT_SQL, [
                    Number(r.locationId),
                    clientId,
                    asString(r.locationName),
                    asString(r.address),
                    asString(r.country),
                    asString(r.state),
                    asString(r.city),
                    resolved.locationId,
                    normalizePincode(r.pincode),
                    Boolean(r.isActive),
                    asString(r.pocName),
                    asString(r.pocEmail),
                    asString(r.pocPhone),
                    asString(r.billingName),
                    asString(r.billingEmailTo),
                    asString(r.billingEmailCc),
                    r.gracePeriod,
                    normalizeGstin(r.gstin),
                    normalizePan(r.pan),
                    asString(r.orderNumber),
                    r.orderDate,
                    kamId,
                    r.createdAt,
                    createdBy,
                    r.updatedAt,
                    resolveAuditUserIdIfTimestamp(
                        r.updatedAt,
                        updatedByRaw,
                        userIds,
                    ),
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
            `Upserted ${upserted} rows into plant_locations ` +
                `(${skippedClient} skipped missing client, ` +
                `defaulted created_by to 1 on ${defaultedCreatedBy} rows, ` +
                `${unresolvedLocation} without resolved location_id, ` +
                `${kamAssigned} with kam_id from client master, ` +
                `${kamSkipped} kam_id skipped invalid user) ` +
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

import pg from "pg";
import { env } from "../../env.js";
import {
    resolveAuditUserId,
    resolveAuditUserIdIfTimestamp,
    SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { upsertBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";
import {
    asString,
    loadLocationLookupMap,
    resolveLocationId,
} from "./resolve-location-id.js";

const SOURCE_SQL = `
SELECT
  LocationId                     AS locationId,
  ClientId                       AS clientId,
  LocationName                   AS locationName,
  LTRIM(RTRIM(Country))          AS country,
  LTRIM(RTRIM(State))            AS state,
  LTRIM(RTRIM(City))             AS city,
  IsActive                       AS isActive,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy                      AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy                      AS updatedBy
FROM tbl_Config_MaterialLocation
`;

const HEAD_SQL = `
INSERT INTO material_locations (
  id, client_id, name, country, state, city, location_id, pincode, is_active,
  created_at, created_by, updated_at, updated_by
)`;

const TAIL_SQL = `
ON CONFLICT (id) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  name = EXCLUDED.name,
  country = EXCLUDED.country,
  state = EXCLUDED.state,
  city = EXCLUDED.city,
  location_id = EXCLUDED.location_id,
  pincode = EXCLUDED.pincode,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
    locationId: number;
    clientId: number | null;
    locationName: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
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
    return new Set(res.rows.map((r) => r.id));
}

async function loadUserIds(pool: pg.Pool): Promise<Set<number>> {
    const res = await pool.query<{ id: number }>("SELECT id FROM users");
    return new Set(res.rows.map((r) => r.id));
}

async function main() {
    const started = Date.now();
    const mssqlPool = await connectMssql();
    const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

    try {
        const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
        console.log(
            `Pulled ${result.recordset.length} material location rows from MSSQL.`,
        );
        if (result.recordset.length === 0) {
            console.log("Nothing to seed.");
            return;
        }

        const [locationMap, clientIds, userIds] = await Promise.all([
            loadLocationLookupMap(pgPool),
            loadClientIds(pgPool),
            loadUserIds(pgPool),
        ]);
        userIds.add(SEED_DEFAULT_USER_ID);

        // Build rows in-memory (13 params each)
        const rows: unknown[][] = [];
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

        for (const r of result.recordset) {
            if (r.clientId == null || !clientIds.has(r.clientId)) {
                skippedClient++;
                continue;
            }

            const createdBy = resolveAuditUserId(r.createdBy, userIds);
            if (r.createdBy !== createdBy) defaultedCreatedBy++;

            const resolved = resolveLocationId(locationMap, r.country, r.state, r.city);
            if (resolved.locationId == null && resolved.state && resolved.city) {
                unresolvedLocation++;
                unmatchedLocations.push({
                    id: r.locationId,
                    clientId: r.clientId,
                    country: resolved.country,
                    state: resolved.state,
                    city: resolved.city,
                });
            } else if (resolved.locationId == null) {
                unresolvedLocation++;
            }

            rows.push([
                r.locationId,
                r.clientId,
                asString(r.locationName),
                asString(r.country),
                asString(r.state),
                asString(r.city),
                resolved.locationId,
                null,
                Boolean(r.isActive),
                r.createdAt,
                createdBy,
                r.updatedAt,
                resolveAuditUserIdIfTimestamp(r.updatedAt, r.updatedBy, userIds),
            ]);
        }

        const client = await pgPool.connect();
        try {
            await client.query("BEGIN");
            await upsertBatched(client, "material_locations", HEAD_SQL, TAIL_SQL, rows);
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }

        console.log(
            `Upserted ${rows.length} rows into material_locations ` +
                `(${skippedClient} skipped missing client, ` +
                `defaulted created_by to 1 on ${defaultedCreatedBy} rows, ` +
                `${unresolvedLocation} without resolved location_id) ` +
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

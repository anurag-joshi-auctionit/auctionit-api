import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { upsertBatched } from "./batch-write.js";
import { buildBidderVan } from "../../lib/bidders/van.js";
import { connectMssql } from "./mssql.js";
import { loadLocationLookupMap, resolveLocationId } from "./resolve-location-id.js";

const SOURCE_SQL = `
SELECT
  BidderCompId                     AS bidderId,
  CompanyName                      AS companyName,
  RegisteredAddress                AS address,
  LTRIM(RTRIM(Country))            AS country,
  LTRIM(RTRIM(State))              AS state,
  LTRIM(RTRIM(City))               AS city,
  LTRIM(RTRIM(PinCode))            AS pincode,
  WebSiteURL                       AS website,
  PAN                              AS pan,
  GST                              AS gstin,
  IsActive                         AS isActive,
  Approved                         AS isVerified,
  CONVERT(varchar(33), ValidFrom, 126) AS validFrom,
  CONVERT(varchar(33), ValidTo, 126)   AS validTo,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy                        AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy                        AS updatedBy
FROM tbl_Config_BidderCompanyMst
`;

const HEAD_SQL = `
INSERT INTO bidders (
  id, company_name, address, location_id,
  country, state, city, pincode,
  website,
  pan, gstin,
  is_active, is_verified, valid_from, valid_to,
  van,
  created_at, created_by, updated_at, updated_by
)`;

const TAIL_SQL = `
ON CONFLICT (id) DO UPDATE SET
  company_name = EXCLUDED.company_name,
  address = EXCLUDED.address,
  location_id = EXCLUDED.location_id,
  country = EXCLUDED.country,
  state = EXCLUDED.state,
  city = EXCLUDED.city,
  pincode = EXCLUDED.pincode,
  website = EXCLUDED.website,
  pan = EXCLUDED.pan,
  gstin = EXCLUDED.gstin,
  is_active = EXCLUDED.is_active,
  is_verified = EXCLUDED.is_verified,
  valid_from = EXCLUDED.valid_from,
  valid_to = EXCLUDED.valid_to,
  -- EMD balance caches are rebuilt from emd_transactions by seed:emd.
  van = COALESCE(bidders.van, EXCLUDED.van),
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
  bidderId: number;
  companyName: string;
  address: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  pincode: string | null;
  website: string | null;
  pan: string | null;
  gstin: string | null;
  isActive: boolean;
  isVerified: boolean;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  createdBy: number;
  updatedAt: string | null;
  updatedBy: number | null;
};

function asString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function normalizePincode(v: string | null): string | null {
  const s = asString(v);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length === 6 ? digits : null;
}

function normalizeTaxId(v: string | null): string | null {
  const s = asString(v);
  return s ? s.toUpperCase() : null;
}

function normalizePan(v: string | null): string | null {
  const s = normalizeTaxId(v);
  return s && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s) ? s : null;
}

function normalizeGstin(v: string | null): string | null {
  const s = normalizeTaxId(v);
  return s && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)
    ? s
    : null;
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(`Pulled ${result.recordset.length} bidder rows from MSSQL.`);
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [userIdsResult, locationMap] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM users"),
      loadLocationLookupMap(pgPool),
    ]);
    const validUserIds = new Set(userIdsResult.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);

    // Build rows in-memory (20 params each — location_id resolved from map)
    const rows: unknown[][] = [];
    let skippedLocation = 0;
    let defaultedCreatedBy = 0;
    let defaultedUpdatedBy = 0;

    for (const r of result.recordset) {
      const createdBy = resolveAuditUserId(r.createdBy, validUserIds);
      if (r.createdBy !== createdBy) defaultedCreatedBy++;
      const updatedBy = resolveAuditUserIdIfTimestamp(r.updatedAt, r.updatedBy, validUserIds);
      if (r.updatedAt != null && (r.updatedBy == null || r.updatedBy !== updatedBy)) {
        defaultedUpdatedBy++;
      }

      const country = asString(r.country) ?? "India";
      const state = asString(r.state);
      const city = asString(r.city);
      if (!state || !city) skippedLocation++;

      const resolved = resolveLocationId(locationMap, r.country, r.state, r.city);

      rows.push([
        r.bidderId,
        r.companyName,
        asString(r.address),
        resolved.locationId,
        country,
        state,
        city,
        normalizePincode(r.pincode),
        asString(r.website),
        normalizePan(r.pan),
        normalizeGstin(r.gstin),
        Boolean(r.isActive),
        Boolean(r.isVerified),
        r.validFrom,
        r.validTo,
        buildBidderVan(Number(r.bidderId)),
        r.createdAt,
        createdBy,
        r.updatedAt,
        updatedBy,
      ]);
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await upsertBatched(client, "bidders", HEAD_SQL, TAIL_SQL, rows);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    console.log(
      `Upserted ${rows.length} rows into bidders ` +
        `(defaulted created_by to 1 on ${defaultedCreatedBy} rows, ` +
        `defaulted updated_by to 1 on ${defaultedUpdatedBy} rows, ` +
        `${skippedLocation} without city/state for location lookup) ` +
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

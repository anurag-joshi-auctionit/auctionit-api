import pg from "pg";
import { ADDITIONAL_FIELD_LABEL_MAX } from "@auctionit/messages/clients";
import { env } from "../../env.js";
import { resolveAuditUserId, SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { connectMssql } from "./mssql.js";

/**
 * Legacy Adani "Update Additional Field" uploads → client_additional_fields +
 * auction_additional_field_values. Field definitions are auto-created per
 * (client, scope, label) as text. A Lot No. of '0' or blank
 * becomes lot_id NULL (auction-level).
 *
 *   pnpm seed:auction-additional-fields [--dry-run]
 */

const SOURCE_SQL = `
SELECT
  Id                        AS id,
  [Auction No.]             AS auctionNo,
  [Lot No.]                 AS lotNo,
  [Additional Field Name]   AS fieldName,
  [Additional Field Value]  AS fieldValue,
  CONVERT(varchar(33), CreatedOn, 126) AS createdAt,
  CreatedBy                 AS createdBy,
  CONVERT(varchar(33), UpdatedOn, 126) AS updatedAt,
  UpdatedBy                 AS updatedBy
FROM tbl_Data_AuctionAdditionalFields
WHERE ISNULL(IsActive, 1) = 1
ORDER BY Id
`;

type SourceRow = {
  id: number;
  auctionNo: string | null;
  lotNo: string | null;
  fieldName: string | null;
  fieldValue: string | null;
  createdAt: string | null;
  createdBy: number | null;
  updatedAt: string | null;
  updatedBy: number | null;
};

type Scope = "auction" | "lot";

const UPSERT_AUCTION_VALUE_SQL = `
INSERT INTO auction_additional_field_values
  (auction_id, lot_id, field_id, value, created_at, created_by, updated_at, updated_by)
VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
ON CONFLICT (auction_id, field_id) WHERE lot_id IS NULL DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

const UPSERT_LOT_VALUE_SQL = `
INSERT INTO auction_additional_field_values
  (auction_id, lot_id, field_id, value, created_at, created_by, updated_at, updated_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (lot_id, field_id) WHERE lot_id IS NOT NULL DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

const norm = (s: string | null | undefined) => (s ?? "").trim();
const key = (s: string) => s.toLowerCase();

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} rows from tbl_Data_AuctionAdditionalFields.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [auctionRows, lotRows, userRows, fieldRows] = await Promise.all([
      pgPool.query<{ id: number; client_id: number; auction_number: string }>(
        "SELECT auction_id AS id, client_id, auction_number FROM auctions WHERE auction_number IS NOT NULL",
      ),
      pgPool.query<{ id: number; auction_id: number; lot_number: string; is_active: boolean }>(
        "SELECT id, auction_id, lot_number, is_active FROM auction_lots WHERE lot_number IS NOT NULL",
      ),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
      pgPool.query<{ id: number; client_id: number; scope: Scope; label: string }>(
        "SELECT id, client_id, scope, label FROM client_additional_fields",
      ),
    ]);

    const validUserIds = new Set(userRows.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);

    // auction_number → auction; ambiguous numbers (shared across auctions) are skipped.
    const auctionsByNo = new Map<string, { id: number; clientId: number }[]>();
    for (const a of auctionRows.rows) {
      const k = key(norm(a.auction_number));
      auctionsByNo.set(k, [
        ...(auctionsByNo.get(k) ?? []),
        { id: a.id, clientId: a.client_id },
      ]);
    }

    // (auction, lot_number) → lot id, preferring active lots.
    const lotByKey = new Map<string, { id: number; active: boolean }>();
    for (const l of lotRows.rows) {
      const k = `${l.auction_id}:${key(norm(l.lot_number))}`;
      const prev = lotByKey.get(k);
      if (!prev || (!prev.active && l.is_active)) {
        lotByKey.set(k, { id: l.id, active: l.is_active });
      }
    }

    const fieldIdByKey = new Map<string, number>();
    for (const f of fieldRows.rows) {
      fieldIdByKey.set(`${f.client_id}:${f.scope}:${key(f.label)}`, f.id);
    }

    const stats = {
      upserted: 0,
      fieldsCreated: 0,
      skippedNoAuctionNo: 0,
      skippedUnknownAuction: 0,
      skippedAmbiguousAuction: 0,
      skippedUnknownLot: 0,
      skippedNoFieldName: 0,
      truncatedLabels: 0,
    };

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        const auctionNo = norm(r.auctionNo);
        if (!auctionNo) {
          stats.skippedNoAuctionNo++;
          continue;
        }
        const matches = auctionsByNo.get(key(auctionNo));
        if (!matches) {
          stats.skippedUnknownAuction++;
          continue;
        }
        if (matches.length > 1) {
          stats.skippedAmbiguousAuction++;
          continue;
        }
        const auction = matches[0]!;

        let label = norm(r.fieldName);
        if (!label) {
          stats.skippedNoFieldName++;
          continue;
        }
        if (label.length > ADDITIONAL_FIELD_LABEL_MAX) {
          label = label.slice(0, ADDITIONAL_FIELD_LABEL_MAX).trim();
          stats.truncatedLabels++;
        }

        const lotNo = norm(r.lotNo);
        const scope: Scope = lotNo === "" || lotNo === "0" ? "auction" : "lot";
        let lotId: number | null = null;
        if (scope === "lot") {
          const lot = lotByKey.get(`${auction.id}:${key(lotNo)}`);
          if (!lot) {
            stats.skippedUnknownLot++;
            continue;
          }
          lotId = lot.id;
        }

        const createdBy = resolveAuditUserId(r.createdBy, validUserIds);
        const createdAt = r.createdAt ?? new Date().toISOString();
        const updatedBy =
          r.updatedAt != null ? resolveAuditUserId(r.updatedBy, validUserIds) : null;

        const fieldKey = `${auction.clientId}:${scope}:${key(label)}`;
        let fieldId = fieldIdByKey.get(fieldKey);
        if (fieldId == null) {
          const inserted = await client.query<{ id: number }>(
            `INSERT INTO client_additional_fields
               (client_id, label, scope, data_type, display_order, is_active, created_at, created_by)
             VALUES ($1, $2, $3, 'text', 0, true, $4, $5)
             RETURNING id`,
            [auction.clientId, label, scope, createdAt, createdBy],
          );
          fieldId = inserted.rows[0]!.id;
          fieldIdByKey.set(fieldKey, fieldId);
          stats.fieldsCreated++;
        }

        const value = norm(r.fieldValue) || null;
        if (lotId == null) {
          await client.query(UPSERT_AUCTION_VALUE_SQL, [
            auction.id,
            fieldId,
            value,
            createdAt,
            createdBy,
            r.updatedAt,
            updatedBy,
          ]);
        } else {
          await client.query(UPSERT_LOT_VALUE_SQL, [
            auction.id,
            lotId,
            fieldId,
            value,
            createdAt,
            createdBy,
            r.updatedAt,
            updatedBy,
          ]);
        }
        stats.upserted++;
      }
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `${dryRun ? "[dry-run, rolled back] " : ""}` +
        `Upserted ${stats.upserted} values, created ${stats.fieldsCreated} client fields ` +
        `(skipped: ${stats.skippedNoAuctionNo} no auction no., ` +
        `${stats.skippedUnknownAuction} auction not in Postgres, ` +
        `${stats.skippedAmbiguousAuction} ambiguous auction no., ` +
        `${stats.skippedUnknownLot} lot not in Postgres, ` +
        `${stats.skippedNoFieldName} no field name; ` +
        `${stats.truncatedLabels} labels truncated to ${ADDITIONAL_FIELD_LABEL_MAX}) ` +
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

import pg from "pg";
import { env } from "../../env.js";
import { decryptLegacyBankField } from "../../lib/legacy-crypto.js";
import { encryptField } from "../../lib/field-encryption.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { connectMssql } from "./mssql.js";

const SOURCE_SQL = `
SELECT
  Id                              AS id,
  BidderCompId                    AS bidderId,
  AcNumber                        AS bankAccount,
  BankName                        AS bankName,
  IFSCCode                        AS bankIfsc,
  CONVERT(varchar(33), CreatedOn, 126) AS createdAt,
  IsVerifiedByAdmin               AS isVerified
FROM tbl_data_BidderBankDetails
`;

const UPSERT_SQL = `
INSERT INTO bidder_bank_accounts (
  id, bidder_id, bank_account, bank_name, bank_ifsc,
  created_at, created_by, updated_at, updated_by,
  is_verified
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, NULL, NULL,
  $8
)
ON CONFLICT (id) DO UPDATE SET
  bidder_id = EXCLUDED.bidder_id,
  bank_account = EXCLUDED.bank_account,
  bank_name = EXCLUDED.bank_name,
  bank_ifsc = EXCLUDED.bank_ifsc,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by,
  is_verified = EXCLUDED.is_verified
`;

const BACKFILL_CANCELLED_CHEQUE_SQL = `
UPDATE bidder_bank_accounts b
SET cancelled_cheque_file_name = d.file_name
FROM (
  SELECT DISTINCT ON (bidder_id)
    bidder_id, file_name
  FROM bidder_document_logs
  WHERE document_type_id = 4
    AND is_active = true
    AND file_name IS NOT NULL
    AND file_name <> ''
  ORDER BY bidder_id, created_at DESC, id DESC
) d
WHERE b.bidder_id = d.bidder_id
`;

type SourceRow = {
  id: number;
  bidderId: number;
  bankAccount: string | null;
  bankName: string | null;
  bankIfsc: string | null;
  createdAt: string;
  isVerified: boolean | null;
};

function encryptLegacyField(value: string | null): string | null {
  if (value == null || value === "") return null;
  const plain = decryptLegacyBankField(value);
  if (plain == null || plain === "") return null;
  return encryptField(plain);
}

async function main() {
  if (!env.SENSITIVE_DATA_ENCRYPTION_KEY) {
    throw new Error(
      "SENSITIVE_DATA_ENCRYPTION_KEY must be set before seeding bank accounts.",
    );
  }

  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} bank account rows from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const bidderRows = await pgPool.query<{ id: number }>("SELECT id FROM bidders");
    const validBidderIds = new Set(bidderRows.rows.map((r) => r.id));

    const client = await pgPool.connect();
    let upserted = 0;
    let skippedMissingBidder = 0;
    let skippedEncryptError = 0;

    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        if (!validBidderIds.has(r.bidderId)) {
          skippedMissingBidder++;
          continue;
        }

        try {
          await client.query(UPSERT_SQL, [
            r.id,
            r.bidderId,
            encryptLegacyField(r.bankAccount),
            encryptLegacyField(r.bankName),
            encryptLegacyField(r.bankIfsc),
            r.createdAt,
            SEED_DEFAULT_USER_ID,
            r.isVerified ?? false,
          ]);
          upserted++;
        } catch (err) {
          skippedEncryptError++;
          console.warn(
            `Skipped bank account id=${r.id} bidder=${r.bidderId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      const backfill = await client.query(BACKFILL_CANCELLED_CHEQUE_SQL);
      await client.query("COMMIT");

      console.log(
        `Upserted ${upserted} bidder bank accounts ` +
          `(${skippedMissingBidder} skipped: bidder not in Postgres, ` +
          `${skippedEncryptError} skipped: encrypt error). ` +
          `Backfilled cancelled_cheque_file_name on ${backfill.rowCount ?? 0} rows ` +
          `in ${Date.now() - started}ms.`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
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

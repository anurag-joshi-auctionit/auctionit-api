import pg from "pg";
import { env } from "../../env.js";
import { legacyAuctionDocumentTypePrefix } from "../../lib/auction-document-naming.js";
import {
  AUCTION_DOCUMENT_TYPE_CATALOGUE,
  AUCTION_DOCUMENT_TYPE_TNC,
} from "../../db/schema/auction-documents.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

const SEED_TYPES = [
  { id: AUCTION_DOCUMENT_TYPE_CATALOGUE, name: "Catalogue" },
  { id: AUCTION_DOCUMENT_TYPE_TNC, name: "Terms & Conditions" },
] as const;

const UPSERT_SQL = `
INSERT INTO auction_document_types (
  id, name, file_name_prefix, is_active, created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, $5, $6, NULL, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  file_name_prefix = EXCLUDED.file_name_prefix,
  is_active = EXCLUDED.is_active,
  created_by = EXCLUDED.created_by
`;

async function main() {
  const started = Date.now();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    for (const type of SEED_TYPES) {
      await client.query(UPSERT_SQL, [
        type.id,
        type.name,
        legacyAuctionDocumentTypePrefix(type.id),
        true,
        new Date().toISOString(),
        SEED_DEFAULT_USER_ID,
      ]);
    }
    await client.query("COMMIT");
    console.log(
      `Upserted ${SEED_TYPES.length} auction document types ` +
        `(${SEED_TYPES.map((t) => `${t.id}:${t.name}`).join(", ")}) ` +
        `in ${Date.now() - started}ms.`,
    );
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

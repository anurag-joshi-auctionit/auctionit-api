import pg from "pg";
import { env } from "../../env.js";
import { legacyClientDocumentTypePrefix } from "../../lib/client-document-naming.js";
import {
  CLIENT_DOCUMENT_TYPE_AGREEMENT,
  CLIENT_DOCUMENT_TYPE_TNC,
} from "../schema/client-document-types.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

const TYPES: Array<{ id: number; name: string }> = [
  { id: CLIENT_DOCUMENT_TYPE_AGREEMENT, name: "Agreement" },
  { id: CLIENT_DOCUMENT_TYPE_TNC, name: "Terms & Conditions" },
];

const UPSERT_SQL = `
INSERT INTO client_document_types (
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
    const now = new Date().toISOString();
    for (const type of TYPES) {
      const prefix = legacyClientDocumentTypePrefix(type.id);
      await client.query(UPSERT_SQL, [
        type.id,
        type.name,
        prefix,
        true,
        now,
        SEED_DEFAULT_USER_ID,
      ]);
      console.log(
        `Upserted client document type "${type.name}" (id=${type.id}, prefix=${prefix})`,
      );
    }
    await client.query("COMMIT");
    console.log(`Done in ${Date.now() - started}ms.`);
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

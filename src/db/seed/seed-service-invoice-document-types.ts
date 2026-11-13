import pg from "pg";
import { env } from "../../env.js";
import {
  LEGACY_SERVICE_INVOICE_DOCUMENT_TYPE_PREFIXES,
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
  SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
  SERVICE_INVOICE_DOCUMENT_TYPE_NAMES,
} from "../../lib/service-invoices/service-invoice-document-naming.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

const TYPES = [
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_XLSX,
  SERVICE_INVOICE_DOCUMENT_TYPE_ANNEXURE_PDF,
  SERVICE_INVOICE_DOCUMENT_TYPE_INVOICE_PDF,
] as const;

const UPSERT_SQL = `
INSERT INTO service_invoice_document_types (
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
    for (const id of TYPES) {
      await client.query(UPSERT_SQL, [
        id,
        SERVICE_INVOICE_DOCUMENT_TYPE_NAMES[id],
        LEGACY_SERVICE_INVOICE_DOCUMENT_TYPE_PREFIXES[id],
        true,
        now,
        SEED_DEFAULT_USER_ID,
      ]);
    }
    await client.query("COMMIT");
    console.log(
      `Upserted ${TYPES.length} service invoice document types ` +
        `(${TYPES.map((id) => `${id}=${SERVICE_INVOICE_DOCUMENT_TYPE_NAMES[id]}`).join(", ")}) ` +
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

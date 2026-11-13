import pg from "pg";
import { env } from "../../env.js";
import {
  legacyBidderDocumentTypePrefix,
} from "../../lib/bidder-document-naming.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { connectMssql } from "./mssql.js";
import { legacyAvailFlagToIsActive } from "./legacy-flags.js";

const SOURCE_SQL = `
SELECT
  Id           AS id,
  DocumentType AS name,
  AvailFlag    AS availFlag,
  CONVERT(varchar(33), CreatedDate, 126) AS createdAt
FROM tbl_Config_DocumentType
ORDER BY Id
`;

const UPSERT_SQL = `
INSERT INTO bidder_document_types (
  id, name, file_name_prefix, is_active, created_at, created_by, updated_at, updated_by
) VALUES (
  $1, $2, $3, $4, $5, $6, NULL, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  file_name_prefix = EXCLUDED.file_name_prefix,
  is_active = EXCLUDED.is_active,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by
`;

type SourceRow = {
  id: number;
  name: string | null;
  availFlag: number | null;
  createdAt: string | null;
};

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} document type rows from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const client = await pgPool.connect();
    let upserted = 0;
    let usedNameFallback = 0;

    try {
      await client.query("BEGIN");
      for (const r of result.recordset) {
        let name = r.name?.trim() ?? "";
        if (!name) {
          name = `Document Type ${r.id}`;
          usedNameFallback++;
        }

        await client.query(UPSERT_SQL, [
          r.id,
          name,
          legacyBidderDocumentTypePrefix(r.id),
          legacyAvailFlagToIsActive(r.availFlag),
          r.createdAt ?? new Date().toISOString(),
          SEED_DEFAULT_USER_ID,
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
      `Upserted ${upserted} bidder document types ` +
        `(${usedNameFallback} used name fallback) ` +
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

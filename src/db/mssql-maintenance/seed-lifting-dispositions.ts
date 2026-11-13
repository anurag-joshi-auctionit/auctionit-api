import mssql from "mssql";
import { env } from "../../env.js";

const CLIENT_MERGE_SQL = `
MERGE [lifting_client_disposition_master] AS target
USING (VALUES
  (1, 'OPEN', N'Open', N'', 1, 1),
  (2, 'SHORT_CLOSED', N'Short Closed', N'', 1, 2),
  (3, 'CLOSED', N'Closed', N'', 1, 3),
  (4, 'EMD_FORFEIT', N'EMD Forfeit', N'', 1, 4),
  (5, 'LOT_CANCELLED', N'Lot Cancelled', N'', 1, 5)
) AS source (id, [key], label, description, is_active, sort_order)
ON target.id = source.id
WHEN MATCHED THEN
  UPDATE SET
    [key] = source.[key],
    label = source.label,
    description = source.description,
    is_active = source.is_active,
    sort_order = source.sort_order
WHEN NOT MATCHED THEN
  INSERT (id, [key], label, description, is_active, sort_order)
  VALUES (source.id, source.[key], source.label, source.description, source.is_active, source.sort_order);
`;

const BIDDER_MERGE_SQL = `
MERGE [lifting_bidder_disposition_master] AS target
USING (VALUES
  ('VEHICLE_PLACED', N'Vehicle Placed', N'', 1, 0, 1),
  ('MATERIAL_SITE_NOT_READY', N'Material / Site Not Ready', N'', 1, 0, 2),
  ('LIFTING_ONGOING', N'Lifting Ongoing', N'', 1, 1, 3),
  ('PARTIAL_LIFTING_DONE', N'Partial Lifting Done', N'', 1, 1, 4),
  ('LIFTING_COMPLETED', N'Lifting Completed', N'', 1, 1, 5),
  ('EXTENSION_REQUESTED', N'Extension Requested', N'', 1, 0, 6),
  ('ISSUE_COMPLAINT_RAISED', N'Issue / Complaint Raised', N'', 1, 0, 7),
  ('LOT_CANCELLED_BY_CLIENT', N'Lot Cancelled by Client', N'', 1, 0, 8),
  ('SO_PENDING', N'SO Pending', N'', 1, 0, 9),
  ('EMD_FORFEITURE', N'EMD Forfeiture', N'', 1, 0, 10),
  ('NOT_RESPONDING', N'Not Responding', N'', 1, 0, 11),
  ('WRONG_NUMBER', N'Wrong Number', N'', 1, 0, 12),
  ('FOLLOW_UP_SCHEDULED', N'Follow-up Scheduled', N'', 1, 0, 13)
) AS source ([key], label, description, is_active, requires_lifted_qty, sort_order)
ON target.[key] = source.[key]
WHEN MATCHED THEN
  UPDATE SET
    label = source.label,
    description = source.description,
    is_active = source.is_active,
    requires_lifted_qty = source.requires_lifted_qty,
    sort_order = source.sort_order
WHEN NOT MATCHED THEN
  INSERT ([key], label, description, is_active, requires_lifted_qty, sort_order)
  VALUES (source.[key], source.label, source.description, source.is_active, source.requires_lifted_qty, source.sort_order);
`;

async function main() {
  const pool = await mssql.connect({
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    server: env.MSSQL_SERVER,
    port: env.MSSQL_PORT,
    database: env.MSSQL_DATABASE,
    options: {
      encrypt: env.MSSQL_ENCRYPT,
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
    },
  });

  await pool.request().query(CLIENT_MERGE_SQL);
  await pool.request().query(BIDDER_MERGE_SQL);

  const [clientCount, bidderCount] = await Promise.all([
    pool
      .request()
      .query("SELECT COUNT(*) AS cnt FROM lifting_client_disposition_master"),
    pool
      .request()
      .query("SELECT COUNT(*) AS cnt FROM lifting_bidder_disposition_master"),
  ]);

  console.log(
    `Seeded lifting disposition masters: ${clientCount.recordset[0]?.cnt ?? 0} client, ${bidderCount.recordset[0]?.cnt ?? 0} bidder rows.`,
  );

  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

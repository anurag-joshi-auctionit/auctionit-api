import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserId,
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { upsertBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";

/**
 * Merges two legacy MSSQL user↔client maps into Postgres `user_clients`:
 *   - tbl_Config_ClientCompUser (client / client_limited portal logins)
 *   - tbl_Config_Client_ServiceProvider_Map (KAM / service-provider scope)
 *
 * Role discrimination stays on users.role_id (seed:users maps IsServiceProvider → kam).
 * KAM multi-client scope is NOT stored on users — it comes from this junction.
 *
 * On (userId, clientId) collision: earlier CreateDatetime wins created_*;
 * later effective update wins updated_*; CompUser IsActive preferred when present.
 */

const COMP_USER_SQL = `
SELECT
  UserId        AS userId,
  ClientId      AS clientId,
  IsActive      AS isActive,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy     AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy     AS updatedBy
FROM tbl_Config_ClientCompUser
`;

const SP_MAP_SQL = `
SELECT
  ServiceProvider AS userId,
  ClientId        AS clientId,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy       AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS updatedAt,
  UpdatedBy       AS updatedBy
FROM tbl_Config_Client_ServiceProvider_Map
`;

const HEAD_SQL = `
INSERT INTO user_clients (
  user_id, client_id, is_active,
  created_at, created_by, updated_at, updated_by
)`;

const TAIL_SQL = `
ON CONFLICT (user_id, client_id) DO UPDATE SET
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by
`;

type SourceRow = {
  userId: number;
  clientId: number;
  isActive: boolean;
  createdAt: string | null;
  createdBy: number;
  updatedAt: string | null;
  updatedBy: number | null;
  fromCompUser: boolean;
};

type MergedRow = SourceRow;

function pairKey(userId: number, clientId: number): string {
  return `${userId}:${clientId}`;
}

/** Negative if a is earlier than b; nulls sort last. */
function compareCreated(a: string | null, b: string | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function effectiveUpdated(row: Pick<SourceRow, "updatedAt" | "createdAt">): string | null {
  return row.updatedAt ?? row.createdAt;
}

/** Positive if a is later than b. */
function compareEffectiveUpdated(a: SourceRow, b: SourceRow): number {
  return compareCreated(effectiveUpdated(a), effectiveUpdated(b));
}

function mergeRow(
  existing: MergedRow | undefined,
  incoming: MergedRow,
): MergedRow {
  if (!existing) return incoming;

  const earlier =
    compareCreated(incoming.createdAt, existing.createdAt) < 0
      ? incoming
      : existing;
  const later =
    compareEffectiveUpdated(incoming, existing) > 0 ? incoming : existing;

  const fromCompUser = existing.fromCompUser || incoming.fromCompUser;
  let isActive = true;
  if (fromCompUser) {
    isActive = existing.fromCompUser
      ? existing.isActive
      : incoming.isActive;
  }

  return {
    userId: existing.userId,
    clientId: existing.clientId,
    createdAt: earlier.createdAt,
    createdBy: earlier.createdBy,
    updatedAt: later.updatedAt,
    updatedBy: later.updatedBy,
    isActive,
    fromCompUser,
  };
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const [compResult, spResult] = await Promise.all([
      mssqlPool.request().query<Omit<SourceRow, "fromCompUser" | "isActive"> & { isActive: boolean }>(
        COMP_USER_SQL,
      ),
      mssqlPool.request().query<Omit<SourceRow, "fromCompUser" | "isActive">>(SP_MAP_SQL),
    ]);

    console.log(
      `Pulled ${compResult.recordset.length} CompUser rows + ` +
        `${spResult.recordset.length} ServiceProvider_Map rows from MSSQL.`,
    );

    const byKey = new Map<string, MergedRow>();
    let dualSourced = 0;

    for (const r of compResult.recordset) {
      const key = pairKey(r.userId, r.clientId);
      const had = byKey.has(key);
      byKey.set(
        key,
        mergeRow(byKey.get(key), {
          userId: r.userId,
          clientId: r.clientId,
          isActive: Boolean(r.isActive),
          createdAt: r.createdAt,
          createdBy: r.createdBy,
          updatedAt: r.updatedAt,
          updatedBy: r.updatedBy,
          fromCompUser: true,
        }),
      );
      if (had) dualSourced++;
    }

    for (const r of spResult.recordset) {
      const key = pairKey(r.userId, r.clientId);
      const had = byKey.has(key);
      byKey.set(
        key,
        mergeRow(byKey.get(key), {
          userId: r.userId,
          clientId: r.clientId,
          isActive: true,
          createdAt: r.createdAt,
          createdBy: r.createdBy,
          updatedAt: r.updatedAt,
          updatedBy: r.updatedBy,
          fromCompUser: false,
        }),
      );
      if (had) dualSourced++;
    }

    const merged = [...byKey.values()];
    console.log(
      `Merged to ${merged.length} unique (user, client) pairs ` +
        `(${dualSourced} dual-sourced collisions resolved by timestamp).`,
    );

    if (merged.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [userRows, clientRows] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM users"),
      pgPool.query<{ id: number }>("SELECT id FROM clients"),
    ]);
    const validUserIds = new Set(userRows.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);
    const validClientIds = new Set(clientRows.rows.map((r) => r.id));

    // Build rows in-memory (7 params each)
    const rows: unknown[][] = [];
    let skippedMissingUser = 0;
    let skippedMissingClient = 0;
    let defaultedCreatedBy = 0;
    let defaultedUpdatedBy = 0;

    for (const r of merged) {
      if (!validUserIds.has(r.userId)) { skippedMissingUser++; continue; }
      if (!validClientIds.has(r.clientId)) { skippedMissingClient++; continue; }

      const createdBy = resolveAuditUserId(r.createdBy, validUserIds);
      if (r.createdBy !== createdBy) defaultedCreatedBy++;
      const updatedBy = resolveAuditUserIdIfTimestamp(r.updatedAt, r.updatedBy, validUserIds);
      if (r.updatedAt != null && (r.updatedBy == null || r.updatedBy !== updatedBy)) defaultedUpdatedBy++;

      rows.push([
        r.userId,
        r.clientId,
        Boolean(r.isActive),
        r.createdAt ?? new Date().toISOString(),
        createdBy,
        r.updatedAt,
        updatedBy,
      ]);
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await upsertBatched(client, "user_clients", HEAD_SQL, TAIL_SQL, rows);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `Upserted ${rows.length} rows into user_clients ` +
        `(${skippedMissingUser} skipped: user not in Postgres, ` +
        `${skippedMissingClient} skipped: client not in Postgres, ` +
        `defaulted created_by to 1 on ${defaultedCreatedBy} rows, ` +
        `defaulted updated_by to 1 on ${defaultedUpdatedBy} rows) ` +
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

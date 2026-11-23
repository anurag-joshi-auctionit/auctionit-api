import pg from "pg";
import { hashPasswordForStorage } from "../../auth/hash.js";
import { env } from "../../env.js";
import { ROLE_CODES, type RoleCode } from "../schema/roles.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";
import { applySanitizeContacts } from "./apply-sanitize-contacts.js";
import { upsertBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";

/** Shared password for all seeded users (stored as bcrypt). */
const SEED_PASSWORD = "Welcome@123";

const SOURCE_SQL = `
SELECT
  UserId                AS userId,
  UserLoginName         AS userLoginName,
  Name                  AS name,
  EmailId               AS emailId,
  Designation           AS designation,
  UniqueId              AS uniqueId,
  PhoneNumber           AS phoneNumber,
  SecondryPhoneNumber   AS secondaryPhoneNumber,
  Whatsapp_Number       AS whatsappNumber,
  WhatsappSecNumber     AS whatsappSecNumber,
  Mpin                  AS mpin,
  IsClient              AS isClient,
  IsClientWithLimit     AS isClientWithLimit,
  IsBidder              AS isBidder,
  IsServiceProvider     AS isServiceProvider,
  IsAdminAccount        AS isAdminAccount,
  IsAdmin               AS isAdmin,
  IsSubAdmin            AS isSubAdmin,
  NDNCAccepted          AS ndncAccepted,
  CONVERT(varchar(33), NDNCUpdateTime, 126) AS ndncUpdatedAt,
  IsActive              AS isActive,
  IsOldDesign           AS isOldDesign,
  IsLogin               AS isLogin,
  CONVERT(varchar(33), LastLoginTime, 126)  AS lastLoginAt,
  CONVERT(varchar(33), LastLogoutTime, 126) AS lastLogoutAt,
  SessionId             AS sessionId,
  CONVERT(varchar(33), session_expires_at, 126) AS sessionExpiresAt,
  IPAddress             AS ipAddress,
  Token                 AS token,
  CONVERT(varchar(33), TokenDateTime, 126)  AS tokenAt,
  CONVERT(varchar(33), CreateDatetime, 126) AS createdAt,
  CreatedBy             AS createdBy,
  CONVERT(varchar(33), UpdateDatetime, 126) AS lastUpdatedAt,
  UpdatedBy             AS lastUpdatedBy
FROM tbl_Config_User
`;

const HEAD_SQL = `
INSERT INTO users (
  id, user_login_name, name, email_id, designation, unique_id,
  phone_number, secondary_phone_number, whatsapp_number, whatsapp_sec_number,
  password, previous_password, password_changed, password_algo,
  mpin, forgot_password_otp, forgot_password_otp_created_at,
  role_id,
  ndnc_accepted, ndnc_updated_at,
  is_active, is_old_design,
  is_login, last_login_at, last_logout_at,
  session_id, session_expires_at, ip_address,
  token, token_at,
  created_at, created_by, last_updated_at, last_updated_by
)`;

const TAIL_SQL = `
ON CONFLICT (id) DO UPDATE SET
  user_login_name = EXCLUDED.user_login_name,
  name = EXCLUDED.name,
  email_id = EXCLUDED.email_id,
  designation = EXCLUDED.designation,
  unique_id = EXCLUDED.unique_id,
  phone_number = EXCLUDED.phone_number,
  secondary_phone_number = EXCLUDED.secondary_phone_number,
  whatsapp_number = EXCLUDED.whatsapp_number,
  whatsapp_sec_number = EXCLUDED.whatsapp_sec_number,
  password = EXCLUDED.password,
  previous_password = EXCLUDED.previous_password,
  password_changed = EXCLUDED.password_changed,
  password_algo = EXCLUDED.password_algo,
  mpin = EXCLUDED.mpin,
  forgot_password_otp = EXCLUDED.forgot_password_otp,
  forgot_password_otp_created_at = EXCLUDED.forgot_password_otp_created_at,
  role_id = EXCLUDED.role_id,
  ndnc_accepted = EXCLUDED.ndnc_accepted,
  ndnc_updated_at = EXCLUDED.ndnc_updated_at,
  is_active = EXCLUDED.is_active,
  is_old_design = EXCLUDED.is_old_design,
  is_login = EXCLUDED.is_login,
  last_login_at = EXCLUDED.last_login_at,
  last_logout_at = EXCLUDED.last_logout_at,
  session_id = EXCLUDED.session_id,
  session_expires_at = EXCLUDED.session_expires_at,
  ip_address = EXCLUDED.ip_address,
  token = EXCLUDED.token,
  token_at = EXCLUDED.token_at,
  last_updated_at = EXCLUDED.last_updated_at,
  last_updated_by = EXCLUDED.last_updated_by
`;

type SourceRow = {
  userId: number;
  userLoginName: string;
  name: string;
  emailId: string | null;
  designation: string | null;
  uniqueId: string | null;
  phoneNumber: string | null;
  secondaryPhoneNumber: string | null;
  whatsappNumber: string | null;
  whatsappSecNumber: string | null;
  mpin: string | null;
  isClient: boolean;
  isClientWithLimit: boolean;
  isBidder: boolean;
  isServiceProvider: boolean;
  isAdminAccount: boolean;
  isAdmin: boolean;
  isSubAdmin: boolean | null;
  ndncAccepted: boolean | null;
  ndncUpdatedAt: string | null;
  isActive: boolean;
  isOldDesign: boolean;
  isLogin: boolean | null;
  lastLoginAt: string | null;
  lastLogoutAt: string | null;
  sessionId: string | null;
  sessionExpiresAt: string | null;
  ipAddress: string | null;
  token: string | null;
  tokenAt: string | null;
  createdAt: string;
  createdBy: number | null;
  lastUpdatedAt: string | null;
  lastUpdatedBy: number | null;
};

/** Prefer raw id; map null/undefined/0 → SEED_DEFAULT_USER_ID (no FK on users.created_by). */
function auditUserId(raw: number | null | undefined): number {
  return raw != null && raw !== 0 ? raw : SEED_DEFAULT_USER_ID;
}

function asString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function asBool(v: boolean | null | undefined): boolean | null {
  if (v == null) return null;
  return Boolean(v);
}

function computeRoleCode(r: SourceRow): RoleCode {
  if (r.isAdmin) return ROLE_CODES.admin;
  if (r.isAdminAccount) return ROLE_CODES.account;
  // Legacy sub-admins map to admin (no built-in sub_admin role).
  if (r.isSubAdmin) return ROLE_CODES.admin;
  // KAM / legacy service-provider. Multi-client scope is NOT stored on users —
  // seed:user-clients loads tbl_Config_Client_ServiceProvider_Map into user_clients.
  if (r.isServiceProvider) return ROLE_CODES.kam;
  if (r.isClientWithLimit) return ROLE_CODES.clientLimited;
  if (r.isClient) return ROLE_CODES.client;
  return ROLE_CODES.bidder;
}

async function loadRoleMap(pool: pg.Pool): Promise<Map<string, number>> {
  const result = await pool.query<{ id: number; code: string }>(
    "SELECT id, code FROM roles",
  );
  return new Map(result.rows.map((r) => [r.code, r.id]));
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const roleMap = await loadRoleMap(pgPool);
    const requiredCodes = Object.values(ROLE_CODES);
    const missing = requiredCodes.filter((code) => !roleMap.has(code));
    if (missing.length > 0) {
      throw new Error(
        `Missing role rows in Postgres: ${missing.join(", ")}. Seed the roles table first.`,
      );
    }

    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(`Pulled ${result.recordset.length} user rows from MSSQL.`);
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const { hash: seedPasswordHash, algo: seedPasswordAlgo } =
      await hashPasswordForStorage(SEED_PASSWORD);
    console.log(
      `Seeding all users with password "${SEED_PASSWORD}" (algo=${seedPasswordAlgo}).`,
    );

    // Build rows in-memory (34 params each)
    const rows: unknown[][] = [];
    for (const r of result.recordset) {
      const roleCode = computeRoleCode(r);
      const roleId = roleMap.get(roleCode);
      if (roleId === undefined) throw new Error(`Unknown role code: ${roleCode}`);
      const createdBy = auditUserId(r.createdBy);
      const lastUpdatedBy = r.lastUpdatedAt != null ? auditUserId(r.lastUpdatedBy) : null;
      rows.push([
        r.userId,
        r.userLoginName,
        r.name,
        asString(r.emailId),
        asString(r.designation),
        asString(r.uniqueId),
        asString(r.phoneNumber),
        asString(r.secondaryPhoneNumber),
        asString(r.whatsappNumber),
        asString(r.whatsappSecNumber),
        seedPasswordHash,
        null,
        true,
        seedPasswordAlgo,
        asString(r.mpin),
        null,
        null,
        roleId,
        asBool(r.ndncAccepted),
        r.ndncUpdatedAt,
        Boolean(r.isActive),
        Boolean(r.isOldDesign),
        asBool(r.isLogin),
        r.lastLoginAt,
        r.lastLogoutAt,
        asString(r.sessionId),
        r.sessionExpiresAt,
        asString(r.ipAddress),
        asString(r.token),
        r.tokenAt,
        r.createdAt,
        createdBy,
        r.lastUpdatedAt,
        lastUpdatedBy,
      ]);
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await upsertBatched(client, "users", HEAD_SQL, TAIL_SQL, rows);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log(`Upserted ${rows.length} rows into users in ${Date.now() - started}ms.`);

    // Sanitize contact PII so local/staging never reaches production contacts.
    const sanitizeClient = await pgPool.connect();
    try {
      const counts = await applySanitizeContacts(sanitizeClient);
      console.log(
        `Sanitized contacts: ${counts.bidderUsers} bidder users, ${counts.clientUsers} client users, ` +
          `${counts.plants} plants, ${counts.clients} clients, ${counts.outbox} outbox rows.`,
      );
    } finally {
      sanitizeClient.release();
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

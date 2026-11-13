import pg from "pg";
import { env } from "../../env.js";
import { ROLE_CODES } from "../schema/roles.js";
import { SEED_DEFAULT_USER_ID } from "./audit-user.js";

type RoleSeed = {
  code: (typeof ROLE_CODES)[keyof typeof ROLE_CODES];
  name: string;
  description: string | null;
  isAdmin: boolean;
};

const ROLES: RoleSeed[] = [
  {
    code: ROLE_CODES.admin,
    name: "Admin",
    description: "Full platform admin (permission matrix bypassed).",
    isAdmin: true,
  },
  {
    code: ROLE_CODES.account,
    name: "Accounts",
    // Accounts uses the permission matrix — isAdmin must stay false (no bypass).
    description: "Finance / accounts portal. isAdmin=false; permissions apply.",
    isAdmin: false,
  },
  {
    code: ROLE_CODES.kam,
    name: "KAM",
    description: "Key account manager (service provider).",
    isAdmin: false,
  },
  {
    code: ROLE_CODES.hod,
    name: "HOD",
    description: "Head of department; approves EMD forfeitures.",
    isAdmin: false,
  },
  {
    code: ROLE_CODES.client,
    name: "Client",
    description: "Auction client (seller).",
    isAdmin: false,
  },
  {
    code: ROLE_CODES.clientLimited,
    name: "Client (Limited)",
    description: "Client with limited capabilities.",
    isAdmin: false,
  },
  {
    code: ROLE_CODES.bidder,
    name: "Bidder",
    description: "Auction bidder (buyer).",
    isAdmin: false,
  },
];

/** Legacy codes from previous seeds → new codes (for user remapping). */
const LEGACY_CODE_REMAP: Record<string, string> = {
  account_admin: ROLE_CODES.account,
  sub_admin: ROLE_CODES.admin,
  service_provider: ROLE_CODES.kam,
  client_with_limit: ROLE_CODES.clientLimited,
};

const UPSERT_SQL = `
INSERT INTO roles (code, name, description, is_admin, created_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_admin = EXCLUDED.is_admin,
  created_by = COALESCE(roles.created_by, EXCLUDED.created_by)
`;

async function main() {
  const started = Date.now();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // created_by is nullable until seed:bootstrap-user; prefer user 1 when present.
    const userExists = await client.query(
      `SELECT 1 FROM users WHERE id = $1`,
      [SEED_DEFAULT_USER_ID],
    );
    const createdBy =
      userExists.rowCount && userExists.rowCount > 0
        ? SEED_DEFAULT_USER_ID
        : null;

    for (const role of ROLES) {
      await client.query(UPSERT_SQL, [
        role.code,
        role.name,
        role.description,
        role.isAdmin,
        createdBy,
      ]);
    }

    // Remap users still pointing at legacy role codes
    for (const [legacy, next] of Object.entries(LEGACY_CODE_REMAP)) {
      await client.query(
        `
        UPDATE users u
        SET role_id = r_new.id
        FROM roles r_old, roles r_new
        WHERE u.role_id = r_old.id
          AND r_old.code = $1
          AND r_new.code = $2
        `,
        [legacy, next],
      );
    }

    // Drop obsolete role rows once unused
    await client.query(`
      DELETE FROM roles r
      WHERE r.code IN ('account_admin', 'sub_admin', 'service_provider', 'client_with_limit')
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = r.id)
    `);

    await client.query("COMMIT");
    console.log(`Upserted ${ROLES.length} roles in ${Date.now() - started}ms.`);
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

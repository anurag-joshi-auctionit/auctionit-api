import { and, asc, desc, eq, exists, inArray, ilike, max, notInArray, or, sql, count } from "drizzle-orm";
import {
  UsersErrorMessages,
  UsersValidationMessages,
} from "@auctionit/messages/users";
import { AuthErrorMessages } from "@auctionit/messages/auth";
import { BiddersErrorMessages } from "@auctionit/messages/bidders";
import { ClientsErrorMessages } from "@auctionit/messages/clients";
import { hashPasswordForStorage } from "../auth/hash.js";
import { AuthError, authService } from "./auth.service.js";
import type { TempPasswordEmailReason } from "../lib/auth/password-email-templates.js";
import { generateTemporaryPassword } from "../lib/auth/password-rules.js";
import type {
  CreateEntityUserBody,
  CreateStaffUserInput,
  EntityUsersListParams,
  StaffListQuery,
  StaffUserRole,
  UpdateEntityUserBody,
  UpdateStaffUserInput,
} from "../lib/users/schemas.js";
import { db } from "../db/index.js";
import { bidders } from "../db/schema/bidders.js";
import { clients } from "../db/schema/clients.js";
import {
  isAdminAppRoleCode,
  ROLE_CODES,
  roles,
  type RoleCode,
} from "../db/schema/roles.js";
import { userClients } from "../db/schema/user-clients.js";
import { users } from "../db/schema/users.js";
import { clampPagination } from "./list-query.js";
import { formatUtcNow } from "@auctionit/lib/date";

// Single home for everything that reads/writes the `users` table:
//   * staff/admin accounts (sign into the admin app) — `usersService`
//   * bidder login accounts (linked via `users.bidder_id`) — `bidderUsersService`
//   * client login accounts (linked via `user_clients`) — `clientUsersService`
// All three share the same physical table; the link tables and the role code
// decide which pool a user belongs to.

type Nullish = string | null | undefined;

/** `db` or a transaction handle — both support select/update used by contact sync. */
type DbExecutor = Pick<typeof db, "select" | "update">;

const orNull = (v: Nullish): string | null => {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
};

async function issueTemporaryPasswordForUser(
  userId: number,
  actorId: number,
  reason: TempPasswordEmailReason = "admin_reset",
): Promise<void> {
  try {
    await authService.issueTemporaryPasswordAndEmail(userId, actorId, reason);
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.code === "otp_missing_email") {
        throw new UserError(
          AuthErrorMessages.OTP_MISSING_EMAIL,
          "OTP_MISSING_EMAIL",
        );
      }
      if (err.code === "otp_delivery_failed") {
        throw new UserError(
          AuthErrorMessages.TEMP_PASSWORD_EMAIL_FAILED,
          "OTP_DELIVERY_FAILED",
        );
      }
    }
    throw err;
  }
}

async function nextUserId(): Promise<number> {
  const [row] = await db.select({ value: max(users.id) }).from(users);
  return (row?.value ?? 0) + 1;
}

/** Portal roles that must not appear in admin staff user management. */
const PORTAL_ROLE_CODES: RoleCode[] = [
  ROLE_CODES.account,
  ROLE_CODES.bidder,
  ROLE_CODES.client,
  ROLE_CODES.clientLimited,
];

function staffRolesScope() {
  return notInArray(roles.code, PORTAL_ROLE_CODES);
}

async function resolveRoleId(code: RoleCode): Promise<number> {
  const [row] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, code))
    .limit(1);
  if (!row) throw new UserError(UsersErrorMessages.ROLE_CODE_NOT_FOUND(code), "ROLE_NOT_FOUND");
  return row.id;
}

const CREATABLE_PORTAL_ROLE_CODES: RoleCode[] = [
  ROLE_CODES.client,
  ROLE_CODES.clientLimited,
  ROLE_CODES.bidder,
];

function isCreatablePortalRole(code: string): boolean {
  return CREATABLE_PORTAL_ROLE_CODES.includes(code as RoleCode);
}

async function resolveCreatableRoleId(
  code: string,
): Promise<{ id: number; code: string }> {
  const [row] = await db
    .select({ id: roles.id, code: roles.code, isAdmin: roles.isAdmin })
    .from(roles)
    .where(eq(roles.code, code))
    .limit(1);
  if (
    !row ||
    (!isAdminAppRoleCode(row.code, row.isAdmin) &&
      !isCreatablePortalRole(row.code))
  ) {
    throw new UserError(
      UsersValidationMessages.ROLE_INVALID,
      "ROLE_NOT_FOUND",
    );
  }
  return { id: row.id, code: row.code };
}

/** Case-insensitive exact match. Escape ILIKE wildcards so `_` and `%` stay literal. */
function loginNameEquals(loginName: string) {
  const escaped = loginName.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return ilike(users.userLoginName, escaped);
}

async function assertLoginAvailable(
  loginName: string,
  exceptUserId?: number,
): Promise<void> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(loginNameEquals(loginName))
    .limit(1);
  if (row && row.id !== exceptUserId) {
    throw new UserError(UsersErrorMessages.LOGIN_TAKEN, "LOGIN_TAKEN");
  }
}

/** Public helper for signup username availability checks. */
export async function isLoginAvailable(loginName: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(loginNameEquals(loginName))
    .limit(1);
  return !row;
}

async function assertBidderAvailable(
  bidderId: number,
  exceptUserId?: number,
): Promise<void> {
  const [bidderRow] = await db
    .select({ id: bidders.id })
    .from(bidders)
    .where(eq(bidders.id, bidderId))
    .limit(1);
  if (!bidderRow) {
    throw new UserError(BiddersErrorMessages.BIDDER_NOT_FOUND, "ENTITY_NOT_FOUND");
  }
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.bidderId, bidderId))
    .limit(1);
  if (existing && existing.id !== exceptUserId) {
    throw new UserError(
      UsersErrorMessages.BIDDER_USER_EXISTS,
      "BIDDER_USER_EXISTS",
    );
  }
}

async function assertClientsExist(clientIds: number[]): Promise<void> {
  if (clientIds.length === 0) return;
  const existingClients = await db
    .select({ id: clients.id })
    .from(clients)
    .where(inArray(clients.id, clientIds));
  if (existingClients.length !== clientIds.length) {
    throw new UserError(ClientsErrorMessages.CLIENT_NOT_FOUND, "ENTITY_NOT_FOUND");
  }
}

async function syncUserClientMemberships(
  userId: number,
  clientIds: number[],
  isActive: boolean,
  actingUserId: number,
): Promise<void> {
  const now = formatUtcNow();
  const desired = [...new Set(clientIds)];
  await assertClientsExist(desired);

  const existing = await db
    .select({
      clientId: userClients.clientId,
      isActive: userClients.isActive,
    })
    .from(userClients)
    .where(eq(userClients.userId, userId));

  const existingByClientId = new Map(
    existing.map((row) => [row.clientId, row] as const),
  );
  const desiredSet = new Set(desired);

  for (const row of existing) {
    if (!desiredSet.has(row.clientId) && row.isActive) {
      await db
        .update(userClients)
        .set({
          isActive: false,
          updatedAt: now,
          updatedBy: actingUserId,
        })
        .where(
          and(
            eq(userClients.userId, userId),
            eq(userClients.clientId, row.clientId),
          ),
        );
    }
  }

  for (const clientId of desired) {
    const prior = existingByClientId.get(clientId);
    if (!prior) {
      await db.insert(userClients).values({
        userId,
        clientId,
        isActive,
        createdAt: now,
        createdBy: actingUserId,
      });
      continue;
    }
    if (!prior.isActive || prior.isActive !== isActive) {
      await db
        .update(userClients)
        .set({
          isActive,
          updatedAt: now,
          updatedBy: actingUserId,
        })
        .where(
          and(
            eq(userClients.userId, userId),
            eq(userClients.clientId, clientId),
          ),
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Staff / admin accounts
// ---------------------------------------------------------------------------

export type UserRole = StaffUserRole;
export type UserStatusFilter = "all" | "active" | "inactive";
export type UserRoleFilter = "all" | UserRole;

export type StaffRoleOption = {
  code: string;
  name: string;
};

export type UserListBidderCompany = {
  bidderId: number;
  companyName: string;
};

export type UserListClientCompany = {
  clientId: number;
  companyName: string;
};

export type UserListItem = {
  userId: number;
  name: string;
  userLoginName: string;
  emailId: string | null;
  phoneNumber: string | null;
  designation: string | null;
  role: UserRole;
  roleName: string;
  isActive: boolean;
  lastLoginTime: string | null;
  createDatetime: string;
  bidder: UserListBidderCompany | null;
  clients: UserListClientCompany[];
};

export type UserListCounts = {
  total: number;
  active: number;
  inactive: number;
};

export type UserListResult = {
  items: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: UserListCounts;
};

export type UserDetail = UserListItem & {
  whatsappNumber: string | null;
  secondryPhoneNumber: string | null;
  passwordChanged: boolean;
};

export class UserError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ENTITY_NOT_FOUND"
      | "USER_NOT_FOUND"
      | "LOGIN_TAKEN"
      | "LOGIN_REQUIRED"
      | "BIDDER_USER_EXISTS"
      | "ROLE_NOT_FOUND"
      | "OTP_MISSING_EMAIL"
      | "OTP_DELIVERY_FAILED",
  ) {
    super(message);
    this.name = "UserError";
  }
}

export class UsersService {
  async listStaffRoleOptions(): Promise<StaffRoleOption[]> {
    const rows = await db
      .select({
        code: roles.code,
        name: roles.name,
        isAdmin: roles.isAdmin,
      })
      .from(roles)
      .where(staffRolesScope())
      .orderBy(asc(roles.name));
    return rows
      .filter((r) => isAdminAppRoleCode(r.code, r.isAdmin))
      .map((r) => ({ code: r.code, name: r.name }));
  }

  /** Staff + client/bidder portal roles assignable from New User. */
  async listCreatableRoleOptions(): Promise<StaffRoleOption[]> {
    const rows = await db
      .select({
        code: roles.code,
        name: roles.name,
        isAdmin: roles.isAdmin,
      })
      .from(roles)
      .orderBy(asc(roles.name));
    return rows
      .filter(
        (r) =>
          isAdminAppRoleCode(r.code, r.isAdmin) ||
          isCreatablePortalRole(r.code),
      )
      .map((r) => ({ code: r.code, name: r.name }));
  }

  /** All roles for the Users directory filter (includes portal roles). */
  async listRoleFilterOptions(): Promise<StaffRoleOption[]> {
    const rows = await db
      .select({
        code: roles.code,
        name: roles.name,
      })
      .from(roles)
      .orderBy(asc(roles.name));
    return rows.map((r) => ({ code: r.code, name: r.name }));
  }

  async list(
    opts: Partial<StaffListQuery> = {},
  ): Promise<UserListResult> {
    const search = opts.search?.trim();
    const status = opts.status ?? "all";
    const roleFilter = opts.role?.trim() || "all";
    const clientIdFilter = opts.clientId;
    const bidderIdFilter = opts.bidderId;
    const { page, pageSize, offset } = clampPagination(
      opts.page ?? 1,
      opts.pageSize ?? 10,
    );

    const conditions: ReturnType<typeof and>[] = [];
    if (status === "active") conditions.push(eq(users.isActive, true));
    if (status === "inactive") conditions.push(eq(users.isActive, false));
    if (roleFilter !== "all") {
      conditions.push(eq(roles.code, roleFilter));
    }
    if (clientIdFilter != null) {
      conditions.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(userClients)
            .where(
              and(
                eq(userClients.userId, users.id),
                eq(userClients.clientId, clientIdFilter),
                eq(userClients.isActive, true),
              ),
            ),
        ),
      );
    }
    if (bidderIdFilter != null) {
      conditions.push(eq(users.bidderId, bidderIdFilter));
    }
    if (search) {
      conditions.push(
        or(
          ilike(users.name, `%${search}%`),
          ilike(users.userLoginName, `%${search}%`),
          ilike(users.emailId, `%${search}%`),
          ilike(users.phoneNumber, `%${search}%`),
        )!,
      );
    }

    const whereExpr =
      conditions.length > 0 ? and(...conditions) : undefined;

    const sortBy = opts.sortBy ?? "name";
    const descOrder = opts.sortOrder === "desc";
    const sortCol =
      sortBy === "lastLoginAt"
        ? users.lastLoginAt
        : sortBy === "createdAt"
          ? users.createdAt
          : users.name;
    const orderBy = descOrder
      ? [desc(sortCol), asc(users.id)]
      : [asc(sortCol), asc(users.id)];

    const [rows, [totalRow], [countsRow]] = await Promise.all([
      db
        .select({
          userId: users.id,
          name: users.name,
          userLoginName: users.userLoginName,
          emailId: users.emailId,
          phoneNumber: users.phoneNumber,
          designation: users.designation,
          roleCode: roles.code,
          roleName: roles.name,
          isActive: users.isActive,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
          bidderId: users.bidderId,
        })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(whereExpr),
      db
        .select({
          total: sql<number>`COUNT(*)`,
          active: sql<number>`SUM(CASE WHEN ${users.isActive} THEN 1 ELSE 0 END)`,
          inactive: sql<number>`SUM(CASE WHEN ${users.isActive} THEN 0 ELSE 1 END)`,
        })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId)),
    ]);

    const bidderIds = [
      ...new Set(
        rows
          .filter((r) => r.bidderId != null)
          .map((r) => r.bidderId as number),
      ),
    ];
    const pageUserIds = rows.map((r) => r.userId);

    const [bidderRows, clientMembershipRows] = await Promise.all([
      bidderIds.length > 0
        ? db
            .select({
              bidderId: bidders.id,
              companyName: bidders.companyName,
            })
            .from(bidders)
            .where(inArray(bidders.id, bidderIds))
        : Promise.resolve(
            [] as { bidderId: number; companyName: string }[],
          ),
      pageUserIds.length > 0
        ? db
            .select({
              userId: userClients.userId,
              clientId: clients.id,
              companyName: clients.companyName,
            })
            .from(userClients)
            .innerJoin(clients, eq(clients.id, userClients.clientId))
            .where(
              and(
                inArray(userClients.userId, pageUserIds),
                eq(userClients.isActive, true),
              ),
            )
            .orderBy(asc(clients.companyName), asc(clients.id))
        : Promise.resolve(
            [] as {
              userId: number;
              clientId: number;
              companyName: string;
            }[],
          ),
    ]);

    const bidderById = new Map(
      bidderRows.map((b) => [b.bidderId, b] as const),
    );
    const clientsByUserId = new Map<number, UserListClientCompany[]>();
    for (const row of clientMembershipRows) {
      const list = clientsByUserId.get(row.userId) ?? [];
      list.push({ clientId: row.clientId, companyName: row.companyName });
      clientsByUserId.set(row.userId, list);
    }

    const counts = countsRow ?? { total: 0, active: 0, inactive: 0 };

    return {
      items: rows.map((r) => {
        const bidder =
          r.bidderId != null ? (bidderById.get(r.bidderId) ?? null) : null;
        return {
          userId: r.userId,
          name: r.name,
          userLoginName: r.userLoginName,
          emailId: r.emailId ?? null,
          phoneNumber: r.phoneNumber ?? null,
          designation: r.designation ?? null,
          role: r.roleCode,
          roleName: r.roleName,
          isActive: r.isActive,
          lastLoginTime: r.lastLoginAt ?? null,
          createDatetime: r.createdAt,
          bidder,
          clients: clientsByUserId.get(r.userId) ?? [],
        };
      }),
      total: Number(totalRow?.total ?? 0),
      page,
      pageSize,
      counts: {
        total: Number(counts.total ?? 0),
        active: Number(counts.active ?? 0),
        inactive: Number(counts.inactive ?? 0),
      },
    };
  }

  async get(userId: number): Promise<UserDetail | null> {
    const [row] = await db
      .select({
        user: users,
        roleCode: roles.code,
        roleName: roles.name,
      })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, userId));
    if (!row) return null;

    let bidder: UserListBidderCompany | null = null;
    let clientCompanies: UserListClientCompany[] = [];

    if (row.user.bidderId != null) {
      const [bidderRow] = await db
        .select({
          bidderId: bidders.id,
          companyName: bidders.companyName,
        })
        .from(bidders)
        .where(eq(bidders.id, row.user.bidderId))
        .limit(1);
      bidder = bidderRow ?? null;
    }

    clientCompanies = await db
      .select({
        clientId: clients.id,
        companyName: clients.companyName,
      })
      .from(userClients)
      .innerJoin(clients, eq(clients.id, userClients.clientId))
      .where(
        and(
          eq(userClients.userId, userId),
          eq(userClients.isActive, true),
        ),
      )
      .orderBy(asc(clients.companyName), asc(clients.id));

    return {
      userId: row.user.id,
      name: row.user.name,
      userLoginName: row.user.userLoginName,
      emailId: row.user.emailId ?? null,
      phoneNumber: row.user.phoneNumber ?? null,
      designation: row.user.designation ?? null,
      role: row.roleCode,
      roleName: row.roleName,
      isActive: row.user.isActive,
      lastLoginTime: row.user.lastLoginAt ?? null,
      createDatetime: row.user.createdAt,
      bidder,
      clients: clientCompanies,
      whatsappNumber: row.user.whatsappNumber ?? null,
      secondryPhoneNumber: row.user.secondaryPhoneNumber ?? null,
      passwordChanged: row.user.passwordChanged,
    };
  }

  async create(input: CreateStaffUserInput, actingUserId: number): Promise<number> {
    const login = input.userLoginName.trim();
    if (!login) {
      throw new UserError(
        UsersValidationMessages.USERNAME_REQUIRED,
        "LOGIN_REQUIRED",
      );
    }

    await assertLoginAvailable(login);

    const role = await resolveCreatableRoleId(input.role);
    // Unusable placeholder until admin Reset Password emails credentials.
    const { hash, algo } = await hashPasswordForStorage(
      generateTemporaryPassword(),
    );
    const now = formatUtcNow();
    const userId = await nextUserId();
    const clientIds = [...new Set(input.clientIds ?? [])];
    const bidderId = input.bidderId ?? null;

    if (bidderId != null) {
      await assertBidderAvailable(bidderId);
    }
    await assertClientsExist(clientIds);

    await db.insert(users).values({
      id: userId,
      userLoginName: login,
      name: input.name,
      emailId: input.emailId,
      phoneNumber: input.phoneNumber,
      whatsappNumber: orNull(input.whatsappNumber),
      designation: input.designation,
      password: hash,
      passwordAlgo: algo,
      passwordChanged: false,
      roleId: role.id,
      bidderId,
      isActive: input.isActive,
      isOldDesign: false,
      createdAt: now,
      createdBy: actingUserId,
    });

    if (clientIds.length > 0) {
      await db.insert(userClients).values(
        clientIds.map((clientId) => ({
          userId,
          clientId,
          isActive: input.isActive,
          createdAt: now,
          createdBy: actingUserId,
        })),
      );
    }

    return userId;
  }

  async update(
    userId: number,
    input: UpdateStaffUserInput,
    actingUserId: number,
  ): Promise<boolean> {
    const [roleRow] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, input.role))
      .limit(1);
    if (!roleRow) {
      throw new UserError(
        UsersValidationMessages.ROLE_INVALID,
        "ROLE_NOT_FOUND",
      );
    }

    const bidderId =
      input.bidderId === undefined
        ? undefined
        : input.bidderId == null
          ? null
          : input.bidderId;
    if (bidderId != null) {
      await assertBidderAvailable(bidderId, userId);
    }

    const result = await db
      .update(users)
      .set({
        name: input.name,
        emailId: input.emailId,
        phoneNumber: input.phoneNumber,
        whatsappNumber: orNull(input.whatsappNumber),
        designation: orNull(input.designation),
        roleId: roleRow.id,
        ...(bidderId !== undefined ? { bidderId } : {}),
        lastUpdatedAt: formatUtcNow(),
        lastUpdatedBy: actingUserId,
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id, isActive: users.isActive });
    if (result.length === 0) return false;

    if (input.clientIds !== undefined) {
      await syncUserClientMemberships(
        userId,
        input.clientIds ?? [],
        result[0]!.isActive,
        actingUserId,
      );
    }

    return true;
  }

  async setActive(
    userId: number,
    isActive: boolean,
    actingUserId: number,
  ): Promise<boolean> {
    const result = await db
      .update(users)
      .set({
        isActive,
        lastUpdatedAt: formatUtcNow(),
        lastUpdatedBy: actingUserId,
      })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return result.length > 0;
  }

  async resetPassword(
    userId: number,
    actingUserId: number,
  ): Promise<boolean> {
    try {
      await authService.applyAdminPasswordReset(userId, actingUserId);
      return true;
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.code === "invalid_credentials") return false;
        if (err.code === "otp_missing_email") {
          throw new UserError(
            AuthErrorMessages.OTP_MISSING_EMAIL,
            "OTP_MISSING_EMAIL",
          );
        }
        if (err.code === "otp_delivery_failed") {
          throw new UserError(
            AuthErrorMessages.TEMP_PASSWORD_EMAIL_FAILED,
            "OTP_DELIVERY_FAILED",
          );
        }
      }
      throw err;
    }
  }
}

export const usersService = new UsersService();

// ---------------------------------------------------------------------------
// Bidder / client login accounts
// ---------------------------------------------------------------------------

export type EntityUserListItem = {
  userId: number;
  name: string;
  userLoginName: string;
  emailId: string | null;
  phoneNumber: string | null;
  whatsappNumber: string | null;
  designation: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

export type BidderUserListItem = EntityUserListItem;

export type EntityUsersListResult = {
  items: EntityUserListItem[];
  total: number;
  page: number;
  pageSize: number;
};

async function createEntityUserRecord(
  input: CreateEntityUserBody,
  roleCode: RoleCode,
  actorId: number,
  opts?: {
    bidderId?: number;
    /**
     * When set (e.g. signup `user_created`), issue + email credentials.
     * Admin create omits this — credentials are sent only via Reset Password.
     */
    credentialsReason?: TempPasswordEmailReason;
  },
): Promise<number> {
  await assertLoginAvailable(input.userLoginName);
  const roleId = await resolveRoleId(roleCode);
  // Unusable placeholder unless credentialsReason triggers issue + email.
  const { hash, algo } = await hashPasswordForStorage(
    generateTemporaryPassword(),
  );
  const now = formatUtcNow();
  const userId = await nextUserId();

  await db.insert(users).values({
    id: userId,
    userLoginName: input.userLoginName,
    name: input.name,
    emailId: input.emailId,
    designation: orNull(input.designation),
    phoneNumber: input.phoneNumber,
    whatsappNumber: orNull(input.whatsappNumber),
    password: hash,
    passwordAlgo: algo,
    passwordChanged: false,
    roleId,
    bidderId: opts?.bidderId,
    isActive: input.isActive ?? true,
    createdAt: now,
    createdBy: actorId,
  });

  if (opts?.credentialsReason) {
    await issueTemporaryPasswordForUser(
      userId,
      actorId,
      opts.credentialsReason,
    );
  }

  return userId;
}

async function updateEntityUserRecord(
  userId: number,
  input: UpdateEntityUserBody,
  actorId: number,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .update(users)
    .set({
      name: input.name,
      emailId: input.emailId,
      phoneNumber: input.phoneNumber,
      whatsappNumber: orNull(input.whatsappNumber),
      designation: orNull(input.designation),
      isActive: input.isActive,
      lastUpdatedAt: formatUtcNow(),
      lastUpdatedBy: actorId,
    })
    .where(eq(users.id, userId));
}

async function resetEntityUserPassword(
  userId: number,
  actorId: number,
): Promise<void> {
  try {
    await authService.applyAdminPasswordReset(userId, actorId);
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.code === "invalid_credentials") {
        throw new UserError(UsersErrorMessages.USER_NOT_FOUND, "USER_NOT_FOUND");
      }
      if (err.code === "otp_missing_email") {
        throw new UserError(
          AuthErrorMessages.OTP_MISSING_EMAIL,
          "OTP_MISSING_EMAIL",
        );
      }
      if (err.code === "otp_delivery_failed") {
        throw new UserError(
          AuthErrorMessages.TEMP_PASSWORD_EMAIL_FAILED,
          "OTP_DELIVERY_FAILED",
        );
      }
    }
    throw err;
  }
}

class BidderUsersService {
  private async requireBidder(bidderId: number): Promise<void> {
    const [row] = await db
      .select({ id: bidders.id })
      .from(bidders)
      .where(eq(bidders.id, bidderId))
      .limit(1);
    if (!row) throw new UserError(BiddersErrorMessages.BIDDER_NOT_FOUND, "ENTITY_NOT_FOUND");
  }

  async listForBidder(
    bidderId: number,
    opts: EntityUsersListParams = { page: 1, pageSize: 10 },
  ): Promise<EntityUsersListResult> {
    await this.requireBidder(bidderId);

    const search = opts.search?.trim();
    const { page, pageSize, offset } = clampPagination(
      opts.page,
      opts.pageSize,
    );

    const conditions = [eq(users.bidderId, bidderId)];
    if (opts.isActive !== undefined) {
      conditions.push(eq(users.isActive, opts.isActive));
    }
    if (search) {
      conditions.push(
        or(
          ilike(users.name, `%${search}%`),
          ilike(users.userLoginName, `%${search}%`),
        )!,
      );
    }
    const whereExpr = and(...conditions);

    const sortBy = opts.sortBy ?? "name";
    const descOrder = opts.sortOrder === "desc";
    const sortCol =
      sortBy === "lastLoginAt" ? users.lastLoginAt : users.name;
    const orderBy = descOrder
      ? [desc(sortCol), asc(users.id)]
      : [asc(sortCol), asc(users.id)];

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(users)
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db.select({ total: count() }).from(users).where(whereExpr),
    ]);

    return {
      items: rows.map((user) => ({
        userId: user.id,
        name: user.name,
        userLoginName: user.userLoginName,
        emailId: user.emailId ?? null,
        phoneNumber: user.phoneNumber ?? null,
        whatsappNumber: user.whatsappNumber ?? null,
        designation: user.designation ?? null,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt ?? null,
        createdAt: user.createdAt,
      })),
      total: Number(totalRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  async createForBidder(
    bidderId: number,
    input: CreateEntityUserBody,
    actorId: number,
    opts?: {
      credentialsReason?: TempPasswordEmailReason;
    },
  ): Promise<{ userId: number }> {
    await this.requireBidder(bidderId);

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.bidderId, bidderId))
      .limit(1);
    if (existing) {
      throw new UserError(
        UsersErrorMessages.BIDDER_USER_EXISTS,
        "BIDDER_USER_EXISTS",
      );
    }

    const userId = await createEntityUserRecord(input, "bidder", actorId, {
      bidderId,
      credentialsReason: opts?.credentialsReason,
    });
    return { userId };
  }

  private async assertLinkedUser(
    bidderId: number,
    userId: number,
  ): Promise<void> {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.bidderId, bidderId), eq(users.id, userId)))
      .limit(1);
    if (!row) throw new UserError(UsersErrorMessages.USER_NOT_FOUND, "USER_NOT_FOUND");
  }

  async updateForBidder(
    bidderId: number,
    userId: number,
    input: UpdateEntityUserBody,
    actorId: number,
  ): Promise<void> {
    await this.assertLinkedUser(bidderId, userId);
    await updateEntityUserRecord(userId, input, actorId);
  }

  async resetPasswordForBidder(
    bidderId: number,
    userId: number,
    actorId: number,
  ): Promise<void> {
    await this.assertLinkedUser(bidderId, userId);
    await resetEntityUserPassword(userId, actorId);
  }
}

class ClientUsersService {
  private async requireClient(clientId: number): Promise<void> {
    const [row] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!row) throw new UserError(ClientsErrorMessages.CLIENT_NOT_FOUND, "ENTITY_NOT_FOUND");
  }

  async listForClient(
    clientId: number,
    opts: EntityUsersListParams = { page: 1, pageSize: 10 },
  ): Promise<EntityUsersListResult> {
    await this.requireClient(clientId);

    const search = opts.search?.trim();
    const { page, pageSize, offset } = clampPagination(
      opts.page,
      opts.pageSize,
    );

    const conditions = [
      eq(userClients.clientId, clientId),
      inArray(roles.code, [ROLE_CODES.client, ROLE_CODES.clientLimited]),
    ];
    if (opts.isActive !== undefined) {
      conditions.push(eq(userClients.isActive, opts.isActive));
    }
    if (search) {
      conditions.push(
        or(
          ilike(users.name, `%${search}%`),
          ilike(users.userLoginName, `%${search}%`),
        )!,
      );
    }
    const whereExpr = and(...conditions);

    const sortBy = opts.sortBy ?? "name";
    const descOrder = opts.sortOrder === "desc";
    const sortCol =
      sortBy === "lastLoginAt" ? users.lastLoginAt : users.name;
    const orderBy = descOrder
      ? [desc(sortCol), asc(users.id)]
      : [asc(sortCol), asc(users.id)];

    const [rows, [totalRow]] = await Promise.all([
      db
        .select({ user: users, link: userClients })
        .from(userClients)
        .innerJoin(users, eq(users.id, userClients.userId))
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(userClients)
        .innerJoin(users, eq(users.id, userClients.userId))
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(whereExpr),
    ]);

    return {
      items: rows.map((r) => ({
        userId: r.user.id,
        name: r.user.name,
        userLoginName: r.user.userLoginName,
        emailId: r.user.emailId ?? null,
        phoneNumber: r.user.phoneNumber ?? null,
        whatsappNumber: r.user.whatsappNumber ?? null,
        designation: r.user.designation ?? null,
        isActive: r.link.isActive,
        lastLoginAt: r.user.lastLoginAt ?? null,
        createdAt: r.link.createdAt,
      })),
      total: Number(totalRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  async createForClient(
    clientId: number,
    input: CreateEntityUserBody,
    actorId: number,
  ): Promise<{ userId: number }> {
    await this.requireClient(clientId);
    const userId = await createEntityUserRecord(input, "client", actorId);
    await db.insert(userClients).values({
      userId,
      clientId,
      isActive: input.isActive ?? true,
      createdAt: formatUtcNow(),
      createdBy: actorId,
    });
    return { userId };
  }

  private async assertLinkedUser(
    clientId: number,
    userId: number,
  ): Promise<void> {
    const [row] = await db
      .select({ userId: userClients.userId })
      .from(userClients)
      .where(
        and(eq(userClients.clientId, clientId), eq(userClients.userId, userId)),
      )
      .limit(1);
    if (!row) throw new UserError(UsersErrorMessages.USER_NOT_FOUND, "USER_NOT_FOUND");
  }

  async updateForClient(
    clientId: number,
    userId: number,
    input: UpdateEntityUserBody,
    actorId: number,
  ): Promise<void> {
    await this.assertLinkedUser(clientId, userId);
    await updateEntityUserRecord(userId, input, actorId);
    await db
      .update(userClients)
      .set({
        isActive: input.isActive,
        updatedAt: formatUtcNow(),
        updatedBy: actorId,
      })
      .where(
        and(eq(userClients.userId, userId), eq(userClients.clientId, clientId)),
      );
  }

  async resetPasswordForClient(
    clientId: number,
    userId: number,
    actorId: number,
  ): Promise<void> {
    await this.assertLinkedUser(clientId, userId);
    await resetEntityUserPassword(userId, actorId);
  }
}

export const bidderUsersService = new BidderUsersService();
export const clientUsersService = new ClientUsersService();

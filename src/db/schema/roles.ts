import { boolean, integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const roles = pgTable("roles", {
  //identity
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

  //role
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: varchar("description", { length: 500 }),

  //flags — when true, permission matrix is bypassed (full feature access)
  isAdmin: boolean("is_admin").notNull().default(false),

  //audit — integer only (no FK) to avoid circular import with users.role_id → roles
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  createdBy: integer("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  updatedBy: integer("updated_by"),
});

export const ROLE_CODES = {
  admin: "admin",
  account: "account",
  kam: "kam",
  hod: "hod",
  client: "client",
  clientLimited: "client_limited",
  bidder: "bidder",
} as const;

export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];

/** Roles that log into the admin SPA (not accounts/bidder/client portals). */
export function isAdminAppRoleCode(code: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  if (code === ROLE_CODES.kam) return true;
  if (
    code === ROLE_CODES.account ||
    code === ROLE_CODES.bidder ||
    code === ROLE_CODES.client ||
    code === ROLE_CODES.clientLimited
  ) {
    return false;
  }
  // Custom staff roles created in UI → admin app
  return true;
}

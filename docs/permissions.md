# Permission keys

Keys are flat strings, usually `domain.action` (e.g. `auction.write`) or `domain.entity.action` (e.g. `emd.refunds.approve`). The dotted form is a naming convention only—there is no separate Scope / Entity / Action data model.

Authorization model:

```
User → one Role → RolePermission(enabled) → Permission.key
```

- **`role.isAdmin`** does **not** bypass the permission matrix. Admin access comes from `role_permissions` like any role. `isAdmin` only means the role can always manage roles and permissions (`ADMIN_GOVERNANCE_KEYS` are always on and cannot be disabled), plus the live-transport kill switch and the admin live-auction view.
- Admin roles get every key by default **except** the Accounts/HOD EMD stage actions (`ADMIN_EXCLUDED_DEFAULT_KEYS`: refund verify/pay, forfeiture review/pay, transfer review). They can be granted explicitly in the matrix. New catalog keys are enabled for admin roles automatically, except those.
- Existing databases: run `pnpm --filter @auctionit/api seed:permissions`. It enables the admin defaults and always turns the excluded stage keys off for `is_admin` roles.
- **`users.is_owner`** is a user flag (not a role). Seeded on one admin user. Only the owner can grant/revoke ownership. Owner and admin can create any role; only owner can set `is_owner`.
- UI hides controls via `can()` / `filterNavigation`; API enforces via `requirePermission` / `requireAnyPermission`.

## Role codes (seeded)

| code | label | App |
|------|-------|-----|
| `admin` | Admin | Admin SPA (`is_admin=true`, matrix minus Accounts/HOD stages) |
| `account` | Accounts | Accounts SPA |
| `kam` | KAM | Admin SPA (subset via matrix) |
| `client` | Client | Client SPA |
| `client_limited` | Client (Limited) | Client SPA |
| `bidder` | Bidder | Bidder SPA |

Custom roles can be created in **Settings → Roles**.

## Permission catalog

Canonical typed list: `@auctionit/authz` → `PERMISSION_KEYS` / `PERMISSION_CATALOG`.

Groups (permission sets in the matrix UI): Modules, Auctions, Clients, Bidders, Inventory, Lifting, Service Invoices, Subscriptions, EMD, Reports, Users, Misc, Masters, Roles & Permissions, Accounts App.

Reports need both `module.reports` (the module) and the per-report key (`reports.<slug>`, e.g. `reports.revenue`), in the API and in the admin nav / routes.

## Evolving keys

1. Add the key to `packages/authz/src/permission-keys.ts`.
2. Add catalog metadata in `packages/authz/src/catalog.ts` (label, description, group).
3. Restart API (bootstrap upserts catalog from code + creates `role_permissions` rows as `enabled=false`).
4. Optionally enable defaults in `SEED_ROLE_PERMISSION_DEFAULTS` and re-run `pnpm seed:permissions` (only enables still-disabled rows).
5. Wire API with `requirePermission` / `requireAnyPermission` and UI with `can()` / nav `permission`.

User-facing copy for roles/permissions lives in `@auctionit/messages/roles`, `@auctionit/messages/permissions`, and `@auctionit/messages/authz` (forbidden / owner policy). API validation returns `{ error, fieldErrors }` via `zodValidationErrorBody`.

Bootstrap **never** silently grants existing roles; new keys start disabled.

## Seed / migrate

```bash
pnpm db:push
pnpm seed:roles
pnpm seed:permissions
pnpm seed:users          # MSSQL flags → role codes; sets is_owner
# optional: SEED_OWNER_LOGIN=some.admin pnpm seed:users
```

MSSQL flag map: `IsAdmin`→`admin`, `IsAdminAccount`→`account`, `IsSubAdmin`→`admin`, `IsServiceProvider`→`kam`, `IsClientWithLimit`→`client_limited`, `IsClient`→`client`, else→`bidder`.

## Frontend masters

- `/roles` — list + create
- `/permissions` — pick role → matrix
- `/permissions/:roleId` — grouped enable/disable switches (governance switches locked on for `isAdmin` roles)

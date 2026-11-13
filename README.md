# @auctionit/api

Express + Drizzle ORM + Postgres.

## Setup

```bash
cp .env.example .env   # fill DATABASE_URL
pnpm db:push           # sync schema from src/db/schema to Postgres
pnpm dev               # http://localhost:4000
```

Edit tables in `src/db/schema/`, then run `pnpm db:push` to apply changes.
Use `pnpm db:generate` / `pnpm db:migrate` only when you adopt versioned migrations later.

## Database seeding

The `src/db/seed/` folder is a **MSSQL → Postgres migration pipeline** plus
Postgres-only reference data (locations, roles, materials, SMS templates).

Full documentation: [`src/db/seed/seed-commands.txt`](src/db/seed/seed-commands.txt).

### Quick start

```bash
# Full pipeline (DB phases A → C + R2 file uploads)
./src/db/seed/seed.sh

# DB phases only (A → C), skip R2 file uploads
./src/db/seed/seed.sh --db-only

# Postgres-only reference data (no MSSQL env required)
pnpm seed:locations
pnpm seed:roles
pnpm seed:materials
pnpm seed:sms-templates
```

Phases B–C require `MSSQL_SERVER`, `MSSQL_PORT`, `MSSQL_USER`, `MSSQL_PASSWORD`,
and `MSSQL_DATABASE` in `.env`.

### Phases

| Phase | Scripts | MSSQL required |
|-------|---------|----------------|
| A | locations, roles, materials, sms-templates | No |
| B | users, clients, plant/material locations, validate-clients, bidders, registrations, user links, blocks | Yes |
| C | auctions, emd-passbook | Yes |

`seed:validate-clients` is a **validation step** (FK checks), not a data import.

### MSSQL maintenance (legacy DB only)

Scripts in `src/db/mssql-maintenance/` update legacy MSSQL tables — they do **not**
seed Postgres:

```bash
pnpm mssql:backfill-latest-lifted [--dry-run]
pnpm mssql:backfill-auctionlot-approval [--dry-run]
pnpm mssql:seed-lifting-dispositions
```

## Endpoints

- `GET  /health`
- `GET  /items`
- `GET  /items/:id`
- `POST /items` — `{ title, description? }`

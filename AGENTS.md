## Validation / user-facing copy

- **Never hardcode validation or toast/error strings** in forms, Zod schemas, API services, or UI.
- Put copy in `packages/messages/src/<domain>/messages.ts` (e.g. `AuctionsValidationMessages`) and import the constant.
- Prefer reusing an existing key; add a new key when the wording or semantics differ.
- Apply the same rule on admin form rules, API write/import schemas, and bulk-upload parsers.
- **Button / menu labels and dialog titles/descriptions** (e.g. "Save", "Cancel", "Download Template", "Bulk Import") stay inline in components — do not put them in messages.

## Database schema

- **Do not create migration `.sql` files** unless explicitly asked.
- Change Drizzle schema under `src/db/schema/` and apply with **`pnpm db:push`**.

## API documentation (OpenAPI / Swagger)

- Every change to a route — new, removed, renamed, or a changed request/response shape — must update its docs in `src/openapi/paths/<router>.ts` (response schemas in `src/openapi/responses/`). Use the `/api-docs` skill. Conventions are in `docs/api/README.md`.
- Then run `pnpm openapi:generate && pnpm openapi:check` and commit `openapi.json` with the change.
- Never add routes to `src/openapi/undocumented.json`; it is a backlog that only shrinks (`pnpm openapi:check --prune`).
- Swagger UI: `http://localhost:3500/docs`.

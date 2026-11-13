---
name: api-docs
description: Document or update OpenAPI/Swagger docs for API routes. Use after adding, changing or removing an Express route or its request/response shape, when `pnpm openapi:check` fails, or to backfill docs for a router ("/api-docs bidders"). Covers where docs live, conventions, and the generate/check commands.
---

# API docs (OpenAPI)

Read `docs/api/README.md` first. It is the source of truth for conventions. This skill is the checklist.

## Arguments
- No argument: document whatever the current change touched. Use `git diff --name-only` and `git status` to find edited files under `src/routes`, `src/lib/**/schemas.ts` and `src/services`.
- `<router>` (e.g. `bidders`, `masters/uoms`): backfill or refresh every route of `src/routes/<router>.ts`.

## Steps
1. **Find the drift.** Run `pnpm openapi:check` from the repo root. It lists undocumented routes, docs for routes that no longer exist, and a stale `openapi.json`.
2. **For each affected router `src/routes/<f>.ts`:**
   - Edit `src/openapi/paths/<f>.ts`, using the same path strings as the router.
   - For a new router: mount it in `src/routes/mounts.ts` with a tag, create `paths/<f>.ts`, and import it from `paths/index.ts` (alphabetical).
   - For each route, read the handler:
     - `query` / `body`: the exact schema the handler `safeParse`s. Reuse the exported schema; recreate inline ones faithfully.
     - `params`: use `IdParam` for `:id`.
     - `responses`: only the codes the handler really sends.
     - Response schemas go in `src/openapi/responses/<f>.ts`. Mirror the service return type, including nullability. Prefix `.openapi("Name")` with the domain.
   - Write a short summary, and add a description only where it helps: side effects, emails/SMS sent, state transitions, business rules.
   - Never describe auth or permissions; they're derived from the middleware.
   - Docs files import only from `src/lib/**`, `zod`, `../common.js`, `../define.js` and `../zod.js`. Never import services or route files.
3. **Shrink the backlog.** If a route you documented was listed in `src/openapi/undocumented.json`, run `pnpm openapi:check --prune`. Never add entries to that file.
4. **Regenerate and verify.**
   - Run `pnpm openapi:generate && pnpm openapi:check`. Both must pass.
   - Run `pnpm typecheck`.
   - To iterate on one file: `pnpm openapi:verify <f>`.
5. **Commit** `openapi.json` together with the code change.

## Gotchas
- Removing or renaming a route? Delete or rename its entry in `paths/`, otherwise the check reports stale docs.
- Mount order in `mounts.ts` matters: `/auctions/me` comes before `/auctions`.
- Nested routers (`router.use("/x", subRouter)`) and non-string paths are rejected by the inventory. Mount sub-routers in `mounts.ts` instead.
- New auth middleware must be tagged with `tagGate()` in `src/auth/middleware.ts`, or the docs will show the route as public.
- The Claude Code hook in `.claude/settings.json` already runs generate + check after edits. If it reports drift, fix it before finishing.

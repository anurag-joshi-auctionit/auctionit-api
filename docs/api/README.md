# API documentation (OpenAPI / Swagger)

The API's OpenAPI 3.0 spec is generated from code. You can browse it two ways:

- **Swagger UI:** `http://localhost:4000/docs` (run `pnpm dev:api`)
- **Raw spec:** `http://localhost:4000/openapi.json`, also committed as [`openapi.json`](../../openapi.json)

Both are on by default outside production. In production they stay off unless `API_DOCS_ENABLED=true`, and then they require an admin login.

To try requests in Swagger UI, log in through `POST /auth/login` and then `POST /auth/login/verify-otp`. Copy `sessionToken`, click **Authorize** and paste it as the Bearer token.

## How it works

| Piece | File | Role |
|---|---|---|
| Route inventory | `src/openapi/route-inventory.ts` | Walks the real Express routers from `src/routes/mounts.ts` and lists every method and path. **Every live route appears in the spec automatically.** |
| Access rules | `src/auth/middleware.ts` (`AuthzGate`) | `requireAuth`, `requirePermission`, `requireAnyPermission`, `requirePortalRole`, etc. carry metadata. The spec derives login, permissions and portal role for each route from the middleware that actually runs (`x-permissions`, `x-portal-role`, `x-admin-only`). |
| Route docs | `src/openapi/paths/<router>.ts` | Summary, description, request schemas and response schemas. Each file mirrors the router file of the same name. |
| Response schemas | `src/openapi/responses/<router>.ts` | Zod schemas that mirror the service return types. |
| Shared parts | `src/openapi/common.ts` | `ErrorBody`, `ValidationErrorBody`, `AuthErrorBody`, `IdParam`, `paginated()`, `OptionIdsResult`, `BinaryFile`. |
| Builder | `src/openapi/document.ts` | Merges the inventory and the route docs. Adds the 400/401/403/500 responses, the security and the `operationId`. |

A route with no entry in `paths/` still shows up, labelled **⚠️ Not yet documented**, with its auth and permissions filled in.

## Commands

| Command | What it does |
|---|---|
| `pnpm openapi:generate` | Rewrites `openapi.json`. Commit it with the code change. |
| `pnpm openapi:check` | Fails if the docs have drifted from the code (see below). |
| `pnpm openapi:check --prune` | Removes stale entries from `undocumented.json`. It never adds entries. |
| `pnpm openapi:verify <file…>` | Builds only the named `paths/` files. Use it to iterate on one domain. |

`openapi:check` fails when:
1. a route exists but has no docs and isn't listed in `src/openapi/undocumented.json` (the backlog);
2. docs exist for a route that's gone, or whose path or method changed;
3. `undocumented.json` lists a route that is now documented or no longer exists;
4. the committed `openapi.json` doesn't match a fresh build.

`undocumented.json` is a backlog that only shrinks. Never add a new route to it; document the route instead.

## Documenting a route

When you add or change a route in `src/routes/foo.ts`:

1. Open `src/openapi/paths/foo.ts`. For a new router, add the mount to `routes/mounts.ts`, create the paths file and import it from `paths/index.ts`.
2. Register the route with the same path string the router uses:

   ```ts
   import { createFooSchema, fooListQuerySchema } from "../../lib/foo/schemas.js";
   import { ErrorBody, IdParam, ValidationErrorBody } from "../common.js";
   import { documentRouter } from "../define.js";
   import { Foo, FooList } from "../responses/foo.js";

   const r = documentRouter("/foo");

   r.get("/", { summary: "List foos", query: fooListQuerySchema, responses: { 200: FooList } });

   r.post("/:id/archive", {
     summary: "Archive foo",
     description: "Soft-deletes the foo and frees its code for reuse.",
     params: IdParam,
     body: archiveFooSchema,
     responses: {
       200: Foo,
       404: { description: "Foo not found.", schema: ErrorBody },
       409: { description: "Foo is used by a live auction.", schema: ErrorBody },
     },
   });
   ```
3. Run `pnpm openapi:generate && pnpm openapi:check`, then commit `openapi.json` together with the change.

### Conventions
- **Request schemas:** reuse the exact Zod schema the handler `safeParse`s (`req.query` goes in `query`, `req.body` in `body`). Don't copy it. If the handler builds an inline schema (for example `schema.extend({...})`), build the same thing in the docs file. To document a field, add `.describe("…")` to the source schema. It has no runtime effect.
- **Path params:** use `IdParam` for `:id`. Other `…Id` params become positive integers automatically. For anything else, pass `params: z.object({...})`.
- **Response schemas:** go in `responses/<router>.ts`, built with `z` from `../zod.js`. Mirror the service's return type in `src/services/*.service.ts`, including `nullable()`. Name reusable shapes with `.openapi("PascalName")`. Names are global across the spec, so prefix generic ones with the domain (`AuctionLot`, not `Lot`).
- **Status codes:** list only what the handler really sends. That means the success code (200 or 201, or 204 with no schema) and route-specific errors such as 404/409/422, or a 400 whose meaning differs from a plain validation error. 400/401/403/500 are added for you.
- **Non-JSON responses:**
  - File downloads: `{ description, schema: BinaryFile, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }`. Use the real MIME type.
  - Redirects: `302: { description: "Redirects to a signed URL." }`.
  - SSE: `contentType: "text/event-stream"`, with the event names and payloads described in `description`.
- **Uploads:** multer routes default to `multipart/form-data`. Pass a `body` such as `z.object({ file: BinaryFile, ... })` to name the fields.
- **Access:** never write auth or permissions in the description, because they're generated from the middleware.
- **Docs file imports:** a docs file may import schemas and types from `src/lib/**`. It must not import services or anything that does I/O.

## Realtime (not covered by OpenAPI)

Live auctions push updates over Socket.IO (`src/live/socket.ts`). The fallback is Server-Sent Events at `GET /live/stream`, which is in the spec. The live transport mode and failover thresholds are served by `GET /live/transport`.

## Automation

- **Claude Code:** `.claude/settings.json` runs `openapi:check` after Claude edits anything under `src/routes`, `src/openapi` or a `schemas.ts`, and reports any drift back to Claude. The `/api-docs` skill (`.claude/skills/api-docs`) walks through documenting a change or backfilling a domain.
- **Humans and CI:** run `pnpm openapi:check` before pushing. It's a good candidate for a CI step.

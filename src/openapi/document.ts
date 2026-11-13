import { createRequire } from "node:module";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type ResponseConfig,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import type { AnyZodObject, ZodTypeAny } from "zod";
import type { AuthzGate } from "../auth/middleware.js";
import { AuthErrorBody, BinaryFile, ErrorBody, ValidationErrorBody } from "./common.js";
import { routeDocs, type ResponseDoc } from "./define.js";
import { collectRoutes, type InventoryRoute } from "./route-inventory.js";
import { z } from "./zod.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

const API_DESCRIPTION = `
REST API behind the AuctionIt admin console, bidder portal and client portal.

## Authentication
1. \`POST /auth/login\` with login name + password. When 2FA is on, an OTP is sent and the response asks for it.
2. \`POST /auth/login/verify-otp\` returns \`{ user, sessionToken }\` and also sets the session cookie.
3. Send the token on every call as \`Authorization: Bearer <sessionToken>\` (use **Authorize** above),
   or rely on the \`session_<appId>\` cookie, where \`appId\` comes from the \`X-App-Id\` header
   (or \`?app_id=\` for top-level navigations).

Sessions are opaque random tokens, not JWTs.

## Access control
Each operation lists its access rule, derived from the route's real middleware:
- **Login required** — any authenticated user.
- **Permissions** — permission keys from \`@auctionit/authz\` (see \`docs/permissions.md\`). Admin roles use the matrix like any other role.
  The same rule is machine-readable in the \`x-permissions\` extension.
- **Portal role** — bidder-portal or client-portal users only (\`x-portal-role\`).

## Errors
| Status | Body | When |
|---|---|---|
| 400 | \`ValidationErrorBody\` \`{ error, fieldErrors }\` | Query/body failed validation |
| 401 | \`AuthErrorBody\` with \`code: "session_invalid"\` | Missing or expired session — clients should log out |
| 403 | \`AuthErrorBody\` with \`code: "permission_denied"\` | Logged in but not allowed |
| 404 | \`ErrorBody\` \`{ error }\` | Entity not found |
| 500 | \`ErrorBody\` | Unexpected server error |

## Realtime
Live bidding also uses Socket.IO and a Server-Sent Events fallback (\`/live/stream\`). Socket.IO events
are not expressible in OpenAPI; see \`docs/api/README.md\`.

Operations marked **⚠️ Not yet documented** are real routes that only have auto-derived metadata so far.
`.trim();

type RouteRequest = NonNullable<RouteConfig["request"]>;

const SECURED: Record<string, string[]>[] = [{ bearerAuth: [] }, { cookieAuth: [] }];

function accessOf(gates: AuthzGate[]) {
  const needsLogin = gates.length > 0;
  const allOf = new Set<string>();
  const anyOf: string[][] = [];
  let portal: "bidder" | "client" | undefined;
  let adminOnly = false;
  for (const g of gates) {
    if (g.kind === "permission") {
      if (g.mode === "all") g.keys.forEach((k) => allOf.add(k));
      else anyOf.push(g.keys);
    } else if (g.kind === "portal") portal = g.role;
    else if (g.kind === "admin") adminOnly = true;
    else if (g.kind === "rolesMaster") adminOnly = true;
  }
  const forbiddenPossible = allOf.size > 0 || anyOf.length > 0 || !!portal || adminOnly;

  const lines: string[] = [];
  if (!needsLogin) lines.push("**Access:** public — no login required.");
  else {
    lines.push("**Access:** login required.");
    if (adminOnly) lines.push("- Admin role only.");
    if (portal) lines.push(`- ${portal === "bidder" ? "Bidder" : "Client"} portal users only.`);
    if (allOf.size > 0) lines.push(`- Requires permission: ${[...allOf].map((k) => `\`${k}\``).join(", ")}.`);
    for (const group of anyOf) {
      lines.push(`- Requires any of: ${group.map((k) => `\`${k}\``).join(", ")}.`);
    }
  }

  const extensions: Record<string, unknown> = {};
  if (allOf.size > 0 || anyOf.length > 0) {
    extensions["x-permissions"] = {
      ...(allOf.size > 0 ? { allOf: [...allOf] } : {}),
      ...(anyOf.length > 0 ? { anyOf } : {}),
    };
  }
  if (portal) extensions["x-portal-role"] = portal;
  if (adminOnly) extensions["x-admin-only"] = true;

  return { needsLogin, forbiddenPossible, text: lines.join("\n"), extensions };
}

function autoParams(route: InventoryRoute): AnyZodObject | undefined {
  if (route.pathParams.length === 0) return undefined;
  const shape: Record<string, ZodTypeAny> = {};
  for (const name of route.pathParams) {
    shape[name] = /id$/i.test(name)
      ? z.coerce.number().int().positive().openapi({ example: 1 })
      : z.string();
  }
  return z.object(shape);
}

function toResponse(doc: ResponseDoc): ResponseConfig {
  if ("_def" in doc) {
    return { description: "Success", content: { "application/json": { schema: doc } } };
  }
  if (!doc.schema) return { description: doc.description };
  return {
    description: doc.description,
    content: { [doc.contentType ?? "application/json"]: { schema: doc.schema } },
  };
}

const json = (schema: ZodTypeAny, description: string): ResponseConfig => ({
  description,
  content: { "application/json": { schema } },
});

/** "get /items/{id}/documents" → "getItemsByIdDocuments" (stable, unique per method+path). */
function operationIdOf(route: InventoryRoute): string {
  const words = route.path
    .split("/")
    .filter(Boolean)
    .flatMap((seg) => {
      const param = /^\{(.+)\}$/.exec(seg);
      return param ? ["by", param[1]!] : seg.split(/[^A-Za-z0-9]+/);
    })
    .filter(Boolean);
  return [route.method, ...words]
    .map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
}

function buildRoute(route: InventoryRoute): RouteConfig {
  const doc = routeDocs.get(route.key);
  const access = accessOf(route.gates);
  const hasInput = !!(doc?.query || doc?.body);

  const description = doc
    ? [doc.description, access.text].filter(Boolean).join("\n\n")
    : [
        "⚠️ **Not yet documented** — request/response schemas are pending. " +
          "Path, auth and permissions below are derived from the live router.",
        access.text,
      ].join("\n\n");

  const responses: RouteConfig["responses"] = {};
  if (doc) {
    for (const [status, r] of Object.entries(doc.responses)) {
      if (r) responses[status] = toResponse(r);
    }
  } else {
    responses["200"] = { description: "Success (response schema not yet documented)." };
  }
  if (hasInput || route.pathParams.length > 0 || route.multipart) {
    responses["400"] ??= json(ValidationErrorBody, "Invalid input.");
  }
  if (access.needsLogin) responses["401"] ??= json(AuthErrorBody, "Not logged in or session expired.");
  if (access.forbiddenPossible) responses["403"] ??= json(AuthErrorBody, "Not allowed for this user.");
  responses["500"] ??= json(ErrorBody, "Unexpected server error.");

  let body: RouteRequest["body"];
  if (doc?.body) {
    const contentType = doc.bodyContentType ?? (route.multipart ? "multipart/form-data" : "application/json");
    body = { required: true, content: { [contentType]: { schema: doc.body } } };
  } else if (route.multipart) {
    body = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: z.object({ file: BinaryFile }).passthrough(),
        },
      },
    };
  }

  return {
    method: route.method,
    path: route.path,
    operationId: operationIdOf(route),
    tags: [route.tag],
    summary: doc?.summary ?? `${route.method.toUpperCase()} ${route.path}`,
    description,
    deprecated: doc?.deprecated,
    security: access.needsLogin ? SECURED : [],
    request: {
      params: doc?.params ?? autoParams(route),
      // RouteDoc.query is typed loosely so docs files can pass the handler's schema as-is.
      query: doc?.query as RouteRequest["query"],
      body,
    },
    responses,
    "x-documented": !!doc,
    ...access.extensions,
  };
}

/**
 * OpenAPI 3.0 has no `null` type, and the generator emits `z.null()` union
 * members as a bare `{ nullable: true }`, which is invalid without `type`.
 * Rewrite them to the usual 3.0 null-only form.
 */
const isBareNullable = (v: unknown): boolean =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === 1 &&
  (v as Record<string, unknown>).nullable === true;

function fixBareNullable(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const entries: [string | number, unknown][] = Array.isArray(node)
    ? node.map((v, i) => [i, v])
    : Object.entries(node);
  for (const [key, child] of entries) {
    if (isBareNullable(child)) {
      (node as Record<string | number, unknown>)[key] = { type: "string", nullable: true, enum: [null] };
    } else fixBareNullable(child);
  }
}

export type OpenApiBuild = {
  document: ReturnType<OpenApiGeneratorV3["generateDocument"]>;
  routes: InventoryRoute[];
};

/** Callers import "./paths/index.js" (or a single paths file) first to register route docs. */
export function buildOpenApi(): OpenApiBuild {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Opaque session token from `POST /auth/login/verify-otp` (`sessionToken`).",
  });
  registry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "session_admin",
    description:
      "Session cookie set at login. Real name is `session_<appId>` from the `X-App-Id` header " +
      "(e.g. `session_admin`, `session_app`); bare `session` when no app id is sent.",
  });
  registry.register("ErrorBody", ErrorBody);
  registry.register("ValidationErrorBody", ValidationErrorBody);
  registry.register("AuthErrorBody", AuthErrorBody);

  const routes = collectRoutes();
  for (const route of routes) {
    try {
      registry.registerPath(buildRoute(route));
    } catch (err) {
      throw new Error(`OpenAPI: failed to register ${route.key}: ${(err as Error).message}`);
    }
  }

  const tags = [...new Set(routes.map((r) => r.tag))].map((name) => ({ name }));
  const generator = new OpenApiGeneratorV3(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.0.3",
    info: { title: "AuctionIt API", version: pkg.version, description: API_DESCRIPTION },
    servers: [{ url: "/", description: "This server" }],
    tags,
  });
  fixBareNullable(document);
  return { document, routes };
}

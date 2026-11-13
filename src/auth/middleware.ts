import type { NextFunction, Request, Response } from "express";
import type { PermissionKey } from "@auctionit/authz";
import { AuthzErrorMessages } from "@auctionit/messages/authz";
import { authService, type AuthUser } from "../services/auth.service.js";
import { sessionCookieName } from "./session-cookie.js";
import {
  hasAnyPermission,
  hasPermission,
  loadEnabledPermissionKeys,
  type AuthzUser,
} from "./permissions.js";
import { isAdminUser, isOwnerUser } from "./permissions.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthzUser;
    }
  }
}

/**
 * What an auth middleware enforces, attached to the middleware function itself
 * so the OpenAPI route inventory (src/openapi/route-inventory.ts) can document
 * auth + permissions for every route straight from the real middleware chain.
 * Purely descriptive — never read at request time.
 */
export type AuthzGate =
  | { kind: "auth" }
  | { kind: "admin" }
  | { kind: "rolesMaster" }
  | { kind: "permission"; mode: "all" | "any"; keys: string[] }
  | { kind: "portal"; role: "bidder" | "client" };

export const AUTHZ_GATE = Symbol.for("auctionit.authzGate");

function tagGate<F extends (...args: never[]) => unknown>(fn: F, gate: AuthzGate): F {
  Object.defineProperty(fn, AUTHZ_GATE, { value: gate });
  return fn;
}

export function authzGateOf(fn: unknown): AuthzGate | undefined {
  if (typeof fn !== "function") return undefined;
  return (fn as unknown as Record<symbol, AuthzGate | undefined>)[AUTHZ_GATE];
}

function readToken(req: Request): string | null {
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = req.cookies?.[sessionCookieName(req)];
  if (typeof cookie === "string" && cookie.length > 0) return cookie;
  return null;
}

/**
 * Discard any unread request body before responding. Auth runs before multer on
 * most routers; if we 401/403 while a large multipart body is still uploading,
 * browsers abort and surface TypeError "Failed to fetch" instead of the JSON
 * error. Draining first keeps the HTTP response readable to fetch().
 */
function drainRequest(req: Request): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded || req.complete) {
      resolve();
      return;
    }
    req.once("end", resolve);
    req.once("error", () => resolve());
    req.resume();
  });
}

async function jsonBeforeBodyConsumed(
  req: Request,
  res: Response,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await drainRequest(req);
  if (!res.headersSent) {
    res.status(status).json(body);
  }
}

async function toAuthzUser(user: AuthUser): Promise<AuthzUser> {
  const permissions = await loadEnabledPermissionKeys(
    user.role.id,
    user.role.isAdmin,
  );
  return { ...user, permissions };
}

// `code: "session_invalid"` marks a genuine authentication failure (no/expired
// session). The frontend uses it to auto-logout. Authorization failures (e.g.
// "Admin only") are NOT flagged, so they surface as in-app errors instead.
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const token = readToken(req);
  if (!token) {
    await jsonBeforeBodyConsumed(req, res, 401, {
      error: AuthzErrorMessages.UNAUTHENTICATED,
      code: "session_invalid",
    });
    return;
  }
  const user = await authService.findBySession(token);
  if (!user) {
    await jsonBeforeBodyConsumed(req, res, 401, {
      error: AuthzErrorMessages.SESSION_INVALID,
      code: "session_invalid",
    });
    return;
  }
  req.user = await toAuthzUser(user);
  next();
}

/** Legacy gate: role.isAdmin only. Prefer requirePermission for new code. */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    await jsonBeforeBodyConsumed(req, res, 401, {
      error: AuthzErrorMessages.UNAUTHENTICATED,
      code: "session_invalid",
    });
    return;
  }
  if (!req.user.role.isAdmin) {
    await jsonBeforeBodyConsumed(req, res, 403, {
      error: AuthzErrorMessages.ADMIN_ONLY,
    });
    return;
  }
  next();
}

export function requirePermission(key: PermissionKey | string) {
  return tagGate(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      await jsonBeforeBodyConsumed(req, res, 401, {
        error: AuthzErrorMessages.UNAUTHENTICATED,
        code: "session_invalid",
      });
      return;
    }
    if (!hasPermission(req.user, key)) {
      await jsonBeforeBodyConsumed(req, res, 403, {
        error: AuthzErrorMessages.FORBIDDEN,
        code: "permission_denied",
      });
      return;
    }
    next();
  }, { kind: "permission", mode: "all", keys: [key] });
}

export function requireAnyPermission(keys: readonly (PermissionKey | string)[]) {
  return tagGate(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      await jsonBeforeBodyConsumed(req, res, 401, {
        error: AuthzErrorMessages.UNAUTHENTICATED,
        code: "session_invalid",
      });
      return;
    }
    if (!hasAnyPermission(req.user, keys)) {
      await jsonBeforeBodyConsumed(req, res, 403, {
        error: AuthzErrorMessages.FORBIDDEN,
        code: "permission_denied",
      });
      return;
    }
    next();
  }, { kind: "permission", mode: "any", keys: [...keys] });
}

/** Roles / Permissions masters: admin role or owner. */
export async function requireRolesMaster(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    await jsonBeforeBodyConsumed(req, res, 401, {
      error: AuthzErrorMessages.UNAUTHENTICATED,
      code: "session_invalid",
    });
    return;
  }
  if (!isAdminUser(req.user) && !isOwnerUser(req.user)) {
    await jsonBeforeBodyConsumed(req, res, 403, {
      error: AuthzErrorMessages.ADMIN_ONLY,
    });
    return;
  }
  next();
}

const PORTAL_CLIENT_ROLE_CODES = new Set(["client", "client_limited"]);

/** External portal role gate — bidder must be linked to a bidder company. */
export function requirePortalRole(role: "bidder" | "client") {
  return tagGate(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      await jsonBeforeBodyConsumed(req, res, 401, {
        error: AuthzErrorMessages.UNAUTHENTICATED,
        code: "session_invalid",
      });
      return;
    }
    if (role === "bidder") {
      if (req.user.role.code !== "bidder" || req.user.bidderId == null) {
        await jsonBeforeBodyConsumed(req, res, 403, {
          error: AuthzErrorMessages.FORBIDDEN,
          code: "permission_denied",
        });
        return;
      }
    } else if (!PORTAL_CLIENT_ROLE_CODES.has(req.user.role.code)) {
      await jsonBeforeBodyConsumed(req, res, 403, {
        error: AuthzErrorMessages.FORBIDDEN,
        code: "permission_denied",
      });
      return;
    }
    next();
  }, { kind: "portal", role });
}

tagGate(requireAuth, { kind: "auth" });
tagGate(requireAdmin, { kind: "admin" });
tagGate(requireRolesMaster, { kind: "rolesMaster" });

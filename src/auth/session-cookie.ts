import type { Request } from "express";

const BASE_COOKIE_NAME = "session";

// Per-app session cookie name. On localhost, cookies are NOT scoped by port, so
// every app (admin, bidder, client, accounts) would otherwise share the single
// `session` cookie and clobber one another when logging into a second app in
// the same browser. Each app sends an `X-App-Id` header; we derive
// `session_<appId>` from it so the apps keep independent sessions. Falls back to
// the bare `session` name when the header is absent (older clients / curl).
export function sessionCookieNameFor(appId: string | undefined | null): string {
  if (!appId) return BASE_COOKIE_NAME;
  // Sanitize to a safe cookie-name token so the header can't inject arbitrary
  // cookie names.
  const id = appId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
  return id ? `${BASE_COOKIE_NAME}_${id}` : BASE_COOKIE_NAME;
}

export function sessionCookieName(req: Request): string {
  // Top-level browser navigations (e.g. opening a document redirect endpoint in
  // a new tab) can't set the `X-App-Id` header, so those URLs carry the app id
  // as an `app_id` query param instead. Header wins when both are present.
  const headerId = req.header("x-app-id");
  const queryId =
    typeof req.query?.app_id === "string" ? req.query.app_id : undefined;
  return sessionCookieNameFor(headerId ?? queryId);
}

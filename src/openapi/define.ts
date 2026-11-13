import type { AnyZodObject, ZodTypeAny } from "zod";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type ResponseDoc =
  | ZodTypeAny
  | {
      description: string;
      /** Omit for empty bodies (e.g. 204, redirects). */
      schema?: ZodTypeAny;
      /** Defaults to application/json. */
      contentType?: string;
    };

export type RouteDoc = {
  summary: string;
  /** Markdown. Access requirements are appended automatically from the middleware. */
  description?: string;
  /** Overrides the auto-derived path params (`:id`-style names ending in "id" become positive ints). */
  params?: AnyZodObject;
  /** Usually the exact schema the handler `safeParse`s `req.query` with. */
  query?: ZodTypeAny;
  /** Usually the exact schema the handler `safeParse`s `req.body` with. */
  body?: ZodTypeAny;
  /** Defaults to multipart/form-data when the route runs multer, else application/json. */
  bodyContentType?: "application/json" | "multipart/form-data" | "application/x-www-form-urlencoded";
  /**
   * Success (and route-specific error) responses keyed by status code. Standard
   * 400/401/403/500 responses are added automatically from the route's
   * middleware and request schemas; list them here only to override.
   */
  responses: Partial<Record<number, ResponseDoc>>;
  deprecated?: boolean;
};

/** "get /items/{id}" — Express `:id` segments normalised to OpenAPI `{id}`. */
export function routeKey(method: string, expressPath: string): string {
  return `${method.toLowerCase()} ${toOpenApiPath(expressPath)}`;
}

export function toOpenApiPath(expressPath: string): string {
  const p = expressPath.replace(/:([A-Za-z0-9_]+)\??/g, "{$1}").replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export function joinPath(prefix: string, path: string): string {
  if (path === "/" || path === "") return prefix;
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Every documented route, keyed by `routeKey()`. Filled by the files in ./paths. */
export const routeDocs = new Map<string, RouteDoc>();

/**
 * Documents the routes of one Express router. Paths are written exactly as in
 * the router file (relative to its mount prefix), so a docs file reads side by
 * side with its router:
 *
 *   const r = documentRouter("/items");
 *   r.get("/:id", { summary: "Get item", responses: { 200: ItemRow } });
 */
export function documentRouter(prefix: string) {
  const add = (method: HttpMethod) => (path: string, doc: RouteDoc) => {
    const key = routeKey(method, joinPath(prefix, path));
    if (routeDocs.has(key)) throw new Error(`OpenAPI: duplicate docs for ${key}`);
    routeDocs.set(key, doc);
  };
  return {
    get: add("get"),
    post: add("post"),
    put: add("put"),
    patch: add("patch"),
    delete: add("delete"),
  };
}

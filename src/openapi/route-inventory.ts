import { authzGateOf, type AuthzGate } from "../auth/middleware.js";
import { routeMounts } from "../routes/mounts.js";
import { joinPath, routeKey, toOpenApiPath, type HttpMethod } from "./define.js";

export type InventoryRoute = {
  key: string;
  method: HttpMethod;
  /** Express-style full path, e.g. /items/:id */
  expressPath: string;
  /** OpenAPI-style full path, e.g. /items/{id} */
  path: string;
  tag: string;
  pathParams: string[];
  /** Auth middleware that runs before the handler (router-level + route-level). */
  gates: AuthzGate[];
  /** Route runs a multer middleware → multipart/form-data body. */
  multipart: boolean;
};

// Minimal structural view of Express 4 internals (router.stack / Layer / Route).
type Layer = {
  route?: { path: unknown; methods: Record<string, boolean>; stack: Layer[] };
  handle: ((...args: unknown[]) => unknown) & { stack?: unknown };
  regexp: RegExp & { fast_slash?: boolean };
  match(path: string): boolean;
};

const METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

function middlewareOf(layers: Layer[]): { gates: AuthzGate[]; multipart: boolean } {
  const gates: AuthzGate[] = [];
  let multipart = false;
  for (const layer of layers) {
    const gate = authzGateOf(layer.handle);
    if (gate) gates.push(gate);
    if (layer.handle.name === "multerMiddleware") multipart = true;
  }
  return { gates, multipart };
}

/** Every method+path the API actually serves, read from the live router objects. */
export function collectRoutes(): InventoryRoute[] {
  const routes: InventoryRoute[] = [
    {
      key: routeKey("get", "/health"),
      method: "get",
      expressPath: "/health",
      path: "/health",
      tag: "System",
      pathParams: [],
      gates: [],
      multipart: false,
    },
  ];

  for (const { prefix, router, tag } of routeMounts) {
    const stack = (router as unknown as { stack: Layer[] }).stack;
    stack.forEach((layer, index) => {
      if (!layer.route) {
        if (Array.isArray(layer.handle.stack)) {
          throw new Error(
            `OpenAPI inventory: nested router under ${prefix} is not supported — mount it in routes/mounts.ts instead.`,
          );
        }
        return;
      }
      const routePath = layer.route.path;
      if (typeof routePath !== "string") {
        throw new Error(
          `OpenAPI inventory: ${prefix} has a non-string route path (${String(routePath)}); use a plain string path.`,
        );
      }
      // Router-level middleware registered *before* this route and whose
      // mount path covers it (router.use(mw) or router.use("/sub", mw)).
      const before = stack
        .slice(0, index)
        .filter((l) => !l.route && (l.regexp.fast_slash || l.match(routePath)));
      const routerLevel = middlewareOf(before);
      const routeLevel = middlewareOf(layer.route.stack);
      const expressPath = joinPath(prefix, routePath);
      const pathParams = [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);

      for (const method of METHODS) {
        if (!layer.route.methods[method]) continue;
        routes.push({
          key: routeKey(method, expressPath),
          method,
          expressPath,
          path: toOpenApiPath(expressPath),
          tag,
          pathParams,
          gates: [...routerLevel.gates, ...routeLevel.gates],
          multipart: routerLevel.multipart || routeLevel.multipart,
        });
      }
    });
  }

  // First registration wins in Express, so a later duplicate is unreachable.
  const seen = new Set<string>();
  return routes.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}

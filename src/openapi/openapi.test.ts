import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import "./paths/index.js";
import { routeDocs } from "./define.js";
import { buildOpenApi } from "./document.js";

// Same guarantees as `pnpm openapi:check` (minus the committed openapi.json
// diff), so `pnpm test` also fails when routes and docs drift apart.
describe("OpenAPI docs", () => {
  const { document, routes } = buildOpenApi();
  const pending = new Set<string>(
    JSON.parse(readFileSync(new URL("./undocumented.json", import.meta.url), "utf8")),
  );

  it("documents every live route", () => {
    const missing = routes.filter((r) => !routeDocs.has(r.key) && !pending.has(r.key)).map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it("has no docs for routes that no longer exist", () => {
    const live = new Set(routes.map((r) => r.key));
    expect([...routeDocs.keys()].filter((k) => !live.has(k))).toEqual([]);
  });

  it("marks login-gated routes as secured", () => {
    const login = document.paths["/auth/login"]?.post;
    const items = document.paths["/items"]?.get;
    expect(login?.security).toEqual([]);
    expect(items?.security?.length).toBeGreaterThan(0);
    expect(items?.["x-permissions"]).toEqual({ anyOf: [["module.inventory", "items.read"]] });
  });

  it("gates client writes with the matching write permission", () => {
    const perms = (path: string, method: "post" | "patch" | "put") =>
      (document.paths[path]?.[method] as Record<string, unknown> | undefined)?.["x-permissions"];
    expect(perms("/clients", "post")).toMatchObject({ allOf: ["client.add"] });
    expect(perms("/clients/{id}/company-info", "patch")).toMatchObject({ allOf: ["client.write"] });
    expect(perms("/clients/{id}/users", "post")).toMatchObject({ allOf: ["client.users.write"] });
    expect(perms("/clients/{id}/plant-locations", "post")).toMatchObject({ allOf: ["client.plants.write"] });
    expect(perms("/masters/lifting-bidder-disposition", "post")).toEqual({
      anyOf: [["module.masters", "masters.lifting-bidder-disposition.write"]],
    });
  });
});

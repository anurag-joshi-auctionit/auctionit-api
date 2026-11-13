import type { Express, RequestHandler } from "express";
import swaggerUi from "swagger-ui-express";
import { env } from "../env.js";
import { requireAdmin, requireAuth } from "../auth/middleware.js";

let cached: object | undefined;

async function getDocument(): Promise<object> {
  // Built lazily on first request: walking every router and converting all the
  // Zod schemas is cheap but pointless at boot when nobody opens the docs.
  if (!cached) {
    await import("./paths/index.js");
    const { buildOpenApi } = await import("./document.js");
    cached = buildOpenApi().document;
  }
  return cached;
}

/**
 * GET /openapi.json + Swagger UI at /docs. On by default outside production;
 * in production only when API_DOCS_ENABLED=true, and then admin-only.
 */
export function mountApiDocs(app: Express): void {
  const enabled = env.API_DOCS_ENABLED ?? env.NODE_ENV !== "production";
  if (!enabled) return;

  const guard: RequestHandler[] =
    env.NODE_ENV === "production" ? [requireAuth, requireAdmin] : [];

  app.get("/openapi.json", ...guard, (_req, res, next) => {
    getDocument()
      .then((doc) => res.json(doc))
      .catch(next);
  });

  app.use(
    "/docs",
    ...guard,
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      customSiteTitle: "AuctionIt API docs",
      swaggerOptions: {
        url: "/openapi.json",
        persistAuthorization: true,
        docExpansion: "none",
        filter: true,
        displayRequestDuration: true,
        tryItOutEnabled: false,
      },
    }),
  );
}

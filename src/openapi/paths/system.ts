import { documentRouter } from "../define.js";
import { z } from "../zod.js";

// Docs for the inline /health route in src/index.ts.
const r = documentRouter("");

r.get("/health", {
  summary: "Health check",
  description: "Liveness probe. Also reports the Postgres pool counters for diagnostics.",
  responses: {
    200: z
      .object({
        ok: z.literal(true),
        pool: z.object({
          totalCount: z.number().int(),
          idleCount: z.number().int(),
          waitingCount: z.number().int(),
        }),
      })
      .openapi("HealthStatus"),
  },
});
